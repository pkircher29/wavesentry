const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('node:crypto');
const { spawn, execSync } = require('child_process');
const os = require('os');
const isWindows = os.platform() === 'win32';
const {
  assertDedicatedInputDevice,
  buildCaptureProcessSpec,
  createTrackFilename,
  finalizeOwnedRecording,
  isDedicatedInputDevice,
  normalizeTrackMetadata,
  publishOwnedRecording,
  waitForChildClose
} = require('./owned-audio.js');

const app = express();
const server = http.createServer(app);
const LOOPBACK_HOST = '127.0.0.1';
const PORT = process.env.PORT || 3000;

let RECORDINGS_DIR;
if (process.versions.electron) {
  try {
    const { app: electronApp } = require('electron');
    if (electronApp && typeof electronApp.getPath === 'function') {
      RECORDINGS_DIR = path.join(electronApp.getPath('userData'), 'recordings');
    }
  } catch (_error) {
    // Electron may be unavailable in a plain Node process or packaging step.
  }
}

if (!RECORDINGS_DIR) {
  RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'recordings');
}

const METADATA_FILE = path.join(RECORDINGS_DIR, '.metadata.json');
const STAGING_DIR = path.join(RECORDINGS_DIR, '.staging');
const BREAK_WAVE_PUBLISH_DIR = process.env.BREAK_WAVE_PUBLISH_DIR
  ? path.resolve(process.env.BREAK_WAVE_PUBLISH_DIR)
  : null;

// Ensure recordings directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}
if (!fs.existsSync(STAGING_DIR)) {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}

// Helper: Metadata Management
function loadAllMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const raw = fs.readFileSync(METADATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error reading metadata file:', err.message);
  }
  return {};
}

function saveAllMetadata(meta) {
  const temporaryPath = `${METADATA_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, METADATA_FILE);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch (_cleanupError) {}
    console.error('Error writing metadata file:', err.message);
    return false;
  }
}

function getRecordingMetadata(filename) {
  const all = loadAllMetadata();
  return all[filename] || {
    title: filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' '),
    artist: 'Unknown Artist',
    tags: [],
    notes: '',
    favorite: false,
    sourceKind: 'unknown',
    updatedAt: Date.now()
  };
}

function updateRecordingMetadata(filename, updates) {
  const all = loadAllMetadata();
  const current = all[filename] || {
    title: filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' '),
    artist: 'Unknown Artist',
    tags: [],
    notes: '',
    favorite: false,
    sourceKind: 'unknown'
  };

  all[filename] = {
    ...current,
    ...updates,
    updatedAt: Date.now()
  };
  if (!saveAllMetadata(all)) {
    throw new Error('Failed to persist recording metadata');
  }
  return all[filename];
}

function isValidFilename(filename) {
  if (!filename || typeof filename !== 'string' || filename === '.' || filename === '..') return false;
  if (filename.length > 240 || /[<>:"|?*\u0000-\u001f]/.test(filename)) return false;
  if (/[. ]$/.test(filename)) return false;
  return path.posix.basename(filename) === filename && path.win32.basename(filename) === filename;
}

function isAllowedBrowserOrigin(origin, localPort) {
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    const port = parsed.port || (parsed.protocol === 'http:' ? '80' : '443');
    return parsed.protocol === 'http:' &&
      (parsed.hostname === LOOPBACK_HOST || parsed.hostname === 'localhost') &&
      port === String(localPort);
  } catch (_error) {
    return false;
  }
}

function getRequestLocalPort(req) {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : req.socket.localPort;
}

function enforceLocalBrowserOrigin(req, res, next) {
  if (!isAllowedBrowserOrigin(req.headers.origin, getRequestLocalPort(req))) {
    return res.status(403).json({ error: 'Cross-origin access is not allowed' });
  }
  next();
}

const wss = new WebSocket.Server({
  server,
  maxPayload: 32 * 1024,
  verifyClient({ origin, req }, done) {
    const allowed = isAllowedBrowserOrigin(origin, getRequestLocalPort(req));
    done(allowed, allowed ? undefined : 403, allowed ? undefined : 'Cross-origin access is not allowed');
  }
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  next();
});

app.use(['/api', '/recordings'], enforceLocalBrowserOrigin);

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve recordings statically
app.use('/recordings', express.static(RECORDINGS_DIR));

// Parse JSON request body
app.use(express.json({ limit: '32kb' }));

// API Endpoints
app.get('/api/devices', (req, res) => {
  res.json(listDevices());
});

app.get('/api/recordings', (req, res) => {
  res.json(getRecordingsList());
});

app.get('/api/integration', (_req, res) => {
  res.json({
    breakWavePublishConfigured: Boolean(BREAK_WAVE_PUBLISH_DIR),
    publishMode: 'configured-directory',
    directPurchasedFileImportPreferred: true,
    streamingCaptureSupported: false
  });
});

app.get('/api/recordings/:filename/metadata', (req, res) => {
  const filename = req.params.filename;
  if (!isValidFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  res.json(getRecordingMetadata(filename));
});

app.post('/api/recordings/:filename/metadata', (req, res) => {
  const filename = req.params.filename;
  if (!isValidFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const { title, artist, tags, notes, favorite } = req.body;
  const updated = updateRecordingMetadata(filename, {
    ...(title !== undefined && { title: String(title).trim() }),
    ...(artist !== undefined && { artist: String(artist).trim() }),
    ...(tags !== undefined && { tags: Array.isArray(tags) ? tags : [] }),
    ...(notes !== undefined && { notes: String(notes).trim() }),
    ...(favorite !== undefined && { favorite: Boolean(favorite) })
  });

  broadcast({
    type: 'recordings_list',
    data: getRecordingsList()
  });

  res.json({ success: true, metadata: updated });
});

app.delete('/api/recordings/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!isValidFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(RECORDINGS_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      
      const meta = loadAllMetadata();
      if (meta[filename]) {
        delete meta[filename];
        saveAllMetadata(meta);
      }

      broadcast({
        type: 'recordings_list',
        data: getRecordingsList()
      });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

app.post('/api/recordings/:filename/publish', async (req, res) => {
  const filename = req.params.filename;
  if (!isValidFilename(filename) || !filename.toLowerCase().endsWith('.wav')) {
    return res.status(400).json({ error: 'Only finalized WAV recordings can be published' });
  }
  const forbiddenDestinationKeys = ['destination', 'directory', 'outputPath', 'path', 'publishDir'];
  if (req.body && forbiddenDestinationKeys.some(key => Object.hasOwn(req.body, key))) {
    return res.status(400).json({ error: 'The publish destination is server-configured' });
  }
  if (!BREAK_WAVE_PUBLISH_DIR) {
    return res.status(503).json({ error: 'BREAK_WAVE_PUBLISH_DIR is not configured' });
  }

  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const metadata = getRecordingMetadata(filename);
  if (metadata.sourceKind !== 'owned_input') {
    return res.status(409).json({
      error: 'Only recordings made through the owned-input capture mode can be published'
    });
  }

  try {
    const published = await publishOwnedRecording({
      filename,
      recordingsDir: RECORDINGS_DIR,
      publishDir: BREAK_WAVE_PUBLISH_DIR,
      metadata
    });
    res.status(201).json({
      success: true,
      filename: published.filename,
      sourcePreserved: true,
      embeddedTags: false
    });
  } catch (error) {
    console.error('Break-Wave publish failed:', error.message);
    res.status(500).json({ error: 'Failed to publish owned recording' });
  }
});

// Transcode / Export Audio Endpoint
app.get('/api/recordings/:filename/export', (req, res) => {
  const filename = req.params.filename;
  if (!isValidFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const format = (req.query.format || 'mp3').toLowerCase();
  const bitrate = req.query.bitrate || '320k';
  const baseName = filename.replace(/\.[^/.]+$/, '');
  const meta = getRecordingMetadata(filename);

  const formatConfig = {
    mp3: { codec: 'libmp3lame', ext: 'mp3', mime: 'audio/mpeg' },
    flac: { codec: 'flac', ext: 'flac', mime: 'audio/flac' },
    aac: { codec: 'aac', ext: 'm4a', mime: 'audio/mp4' },
    ogg: { codec: 'libvorbis', ext: 'ogg', mime: 'audio/ogg' },
    wav: { codec: 'pcm_s16le', ext: 'wav', mime: 'audio/wav' }
  };

  const target = formatConfig[format] || formatConfig.mp3;
  const outFilename = `${baseName}.${target.ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${outFilename}"`);
  res.setHeader('Content-Type', target.mime);

  const ffmpegArgs = ['-i', filePath];

  if (meta.title) ffmpegArgs.push('-metadata', `title=${meta.title}`);
  if (meta.artist) ffmpegArgs.push('-metadata', `artist=${meta.artist}`);
  if (meta.notes) ffmpegArgs.push('-metadata', `comment=${meta.notes}`);

  if (target.codec === 'libmp3lame') {
    ffmpegArgs.push('-c:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3', '-');
  } else if (target.codec === 'flac') {
    ffmpegArgs.push('-c:a', 'flac', '-f', 'flac', '-');
  } else if (target.codec === 'aac') {
    ffmpegArgs.push('-c:a', 'aac', '-b:a', bitrate, '-f', 'adts', '-');
  } else if (target.codec === 'libvorbis') {
    ffmpegArgs.push('-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg', '-');
  } else {
    ffmpegArgs.push('-c:a', 'pcm_s16le', '-f', 'wav', '-');
  }

  const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
  ffmpegProc.stdout.pipe(res);

  ffmpegProc.on('error', (err) => {
    console.error('FFmpeg export error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Transcoding failed' });
    }
  });

  req.on('close', () => {
    try {
      ffmpegProc.kill('SIGKILL');
    } catch (e) {}
  });
});

// State management
let activeMonitorProcess = null;
let activeMonitorDevice = null;
let activeRecordingProcess = null;
let activeRecordingDevice = null;
let activeRecordingFile = null;
let recordingStartTime = null;
let recordingTimer = null;
let recordedBytes = 0;
let activeRecordingContext = null;

// Auto-split / Silence detection configuration & state
let targetRecordingDevice = null;
let activeRecordingMetadata = normalizeTrackMetadata();
let autoSplitEnabled = false;
let silenceThresholdDb = -45;
let silenceThresholdLinear = Math.pow(10, -45 / 20);
let silenceDurationMs = 1000;
let silenceStartTimestamp = null;
let isArmedForSound = false;
let latestLevels = { rmsL: 0, rmsR: 0, peakL: 0, peakR: 0, spectrum: [] };

function getDefaultSource() {
  try {
    const out = execSync('wpctl inspect @DEFAULT_AUDIO_SOURCE@', { encoding: 'utf8' });
    const match = out.match(/node\.name\s*=\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function parsePipeWireInputDevices(dump, defaultSource = null) {
  const devices = [];
  for (const obj of Array.isArray(dump) ? dump : []) {
    const props = obj && obj.info && obj.info.props;
    if (!props || props['media.class'] !== 'Audio/Source') continue;
    const name = props['node.name'];
    const description = props['node.description'] || name;
    if (!name || !isDedicatedInputDevice(`${name} ${description}`)) continue;
    devices.push({
      id: name,
      name,
      description,
      nick: props['node.nick'] || '',
      type: 'input',
      captureMode: 'owned_input',
      isDefault: name === defaultSource
    });
  }
  return devices.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.description.localeCompare(b.description);
  });
}

function listDevicesLinux() {
  try {
    const dump = JSON.parse(execSync('pw-dump', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
    return parsePipeWireInputDevices(dump, getDefaultSource());
  } catch (err) {
    console.error('Error listing Linux input devices:', err.message);
    return [];
  }
}

function parseWindowsAudioInputDevices(output) {
    const devices = [];
    const lines = String(output || '').split('\n');
    let inAudio = false;
    for (const line of lines) {
      if (line.includes('DirectShow audio devices')) {
        inAudio = true;
        continue;
      }
      if (line.includes('DirectShow video devices')) {
        inAudio = false;
        continue;
      }
      
      if (inAudio) {
        const match = line.match(/\]\s+"([^"]+)"/);
        if (match) {
          const name = match[1];
          if (!line.includes('Alternative name') &&
              isDedicatedInputDevice(name) &&
              !devices.some(d => d.name === name)) {
            devices.push({
              id: name,
              name: name,
              description: name,
              nick: name,
              type: 'input',
              captureMode: 'owned_input',
              isDefault: devices.length === 0
            });
          }
        }
      }
    }
    return devices;
}

function listDevicesWindows() {
  try {
    let output = '';
    try {
      execSync('ffmpeg -hide_banner -f dshow -list_devices true -i dummy', { stdio: 'pipe' });
    } catch (err) {
      output = err.stderr ? err.stderr.toString() : (err.message || '');
    }
    return parseWindowsAudioInputDevices(output);
  } catch (err) {
    console.error('Error listing Windows input devices:', err.message);
    return [];
  }
}

function listDevices() {
  if (isWindows) {
    return listDevicesWindows();
  } else {
    return listDevicesLinux();
  }
}

function getRecordingsList() {
  try {
    const files = fs.readdirSync(RECORDINGS_DIR);
    const metaMap = loadAllMetadata();

    return files
      .filter(file => file.endsWith('.wav') || file.endsWith('.mp3') || file.endsWith('.flac'))
      .map(file => {
        const filePath = path.join(RECORDINGS_DIR, file);
        const stats = fs.statSync(filePath);
        const meta = metaMap[file] || {};
        return {
          filename: file,
          sizeBytes: stats.size,
          createdAt: stats.birthtimeMs || stats.mtimeMs,
          path: `/recordings/${file}`,
          title: meta.title || file.replace(/\.[^/.]+$/, '').replace(/_/g, ' '),
          artist: meta.artist || 'Unknown Artist',
          tags: meta.tags || [],
          notes: meta.notes || '',
          favorite: Boolean(meta.favorite),
          sourceKind: meta.sourceKind || 'unknown',
          publishEligible: meta.sourceKind === 'owned_input'
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.error('Error listing recordings:', err.message);
    return [];
  }
}

function stopMonitoring() {
  if (activeMonitorProcess) {
    try {
      activeMonitorProcess.kill('SIGTERM');
    } catch (e) {}
    activeMonitorProcess = null;
  }
  activeMonitorDevice = null;
}

function computeSpectrum(slice, frameSize) {
  const bands = 16;
  const energies = new Array(bands).fill(0);
  const sampleCount = Math.floor(slice.length / frameSize);
  if (sampleCount === 0) return energies;

  const bandSize = Math.max(1, Math.floor(sampleCount / bands));
  for (let b = 0; b < bands; b++) {
    let sum = 0;
    let count = 0;
    const start = b * bandSize * frameSize;
    const end = Math.min(slice.length, (b + 1) * bandSize * frameSize);
    for (let i = start; i < end; i += frameSize) {
      const valL = slice.readInt16LE(i) / 32768.0;
      const valR = slice.readInt16LE(i + 2) / 32768.0;
      sum += (Math.abs(valL) + Math.abs(valR)) / 2;
      count++;
    }
    const weight = 1.0 + (b * 0.08);
    energies[b] = count > 0 ? Math.min(1.0, (sum / count) * weight * 1.5) : 0;
  }
  return energies;
}

function startMonitoring(device) {
  stopMonitoring();
  const inputDevice = assertDedicatedInputDevice(device);
  const processSpec = buildCaptureProcessSpec({
    platform: os.platform(),
    device: inputDevice,
    outputPath: '-',
    sampleRate: 16000
  });
  const monitorProcess = spawn(processSpec.command, processSpec.args);
  activeMonitorDevice = inputDevice;
  activeMonitorProcess = monitorProcess;
  
  let buffer = Buffer.alloc(0);
  
  monitorProcess.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const frameSize = 4; // 16-bit stereo
    const chunkSize = 512 * frameSize; // 512 samples
    
    while (buffer.length >= chunkSize) {
      const slice = buffer.slice(0, chunkSize);
      buffer = buffer.slice(chunkSize);
      
      let maxL = 0;
      let maxR = 0;
      let sumSqL = 0;
      let sumSqR = 0;
      const sampleCount = slice.length / frameSize;
      
      for (let i = 0; i < slice.length; i += frameSize) {
        const valL = slice.readInt16LE(i);
        const valR = slice.readInt16LE(i + 2);
        
        const normL = valL / 32768.0;
        const normR = valR / 32768.0;
        
        sumSqL += normL * normL;
        sumSqR += normR * normR;
        
        if (Math.abs(normL) > maxL) maxL = Math.abs(normL);
        if (Math.abs(normR) > maxR) maxR = Math.abs(normR);
      }
      
      const rmsL = Math.sqrt(sumSqL / sampleCount);
      const rmsR = Math.sqrt(sumSqR / sampleCount);
      const spectrum = computeSpectrum(slice, frameSize);
      
      latestLevels = { rmsL, rmsR, peakL: maxL, peakR: maxR, spectrum };
      
      const maxRms = Math.max(rmsL, rmsR);
      
      if (autoSplitEnabled) {
        if (activeRecordingProcess) {
          if (maxRms < silenceThresholdLinear) {
            if (!silenceStartTimestamp) {
              silenceStartTimestamp = Date.now();
            } else if (Date.now() - silenceStartTimestamp >= silenceDurationMs) {
              console.log(`Silence detected for ${silenceDurationMs}ms. Auto-stopping current recording.`);
              void stopRecording();
              isArmedForSound = true;
              silenceStartTimestamp = null;
              broadcastStatus();
            }
          } else {
            silenceStartTimestamp = null;
          }
        } else if (isArmedForSound) {
          if (maxRms >= silenceThresholdLinear) {
            console.log(`Sound detected above ${silenceThresholdDb}dB. Auto-starting new recording.`);
            isArmedForSound = false;
            void startRecording(targetRecordingDevice, activeRecordingMetadata);
          }
        }
      }
      
      broadcast({
        type: 'levels',
        data: {
          peakL: maxL,
          peakR: maxR,
          rmsL: rmsL,
          rmsR: rmsR,
          spectrum: spectrum
        }
      });
    }
  });
  
  monitorProcess.on('close', () => {
    if (activeMonitorProcess === monitorProcess) {
      activeMonitorProcess = null;
      activeMonitorDevice = null;
      broadcastStatus();
    }
  });
  
  monitorProcess.on('error', (error) => {
    console.error('Audio input monitor failed:', error.message);
    broadcast({ type: 'error', data: { message: 'Unable to monitor the selected audio input' } });
  });
  monitorProcess.stderr.on('data', () => {});
}

async function finishRecordingContext(context, code, signal) {
  if (context.forceKillTimer) clearTimeout(context.forceKillTimer);
  if (context.timer) clearInterval(context.timer);

  let result = null;
  try {
    const expectedSignal = context.stopRequested && (signal === 'SIGINT' || signal === 'SIGTERM');
    if (context.spawnError) throw context.spawnError;
    if (code !== 0 && !expectedSignal) {
      throw new Error(`Capture process exited before finalization (code ${code}, signal ${signal || 'none'})`);
    }
    result = await finalizeOwnedRecording({
      tempPath: context.tempPath,
      recordingsDir: RECORDINGS_DIR,
      ...context.metadata,
      id: context.id,
      device: context.device,
      capturedAt: new Date(context.startedAt).toISOString(),
      persistMetadata: updateRecordingMetadata
    });
    if (result.stagingCleanupPending) {
      console.warn(`Finalized recording saved, but its staging path was preserved for recovery at ${context.tempPath}`);
    }
    broadcast({
      type: 'recording_complete',
      data: {
        filename: result.filename,
        sizeBytes: result.sizeBytes,
        sourceKind: 'owned_input'
      }
    });
  } catch (error) {
    console.error('Recording finalization failed:', error.message);
    console.error(`Staging data, if still present, was preserved for recovery at ${context.tempPath}`);
    broadcast({
      type: 'error',
      data: { message: `Recording was not saved: ${error.message}` }
    });
  } finally {
    if (activeRecordingContext === context) {
      activeRecordingContext = null;
      activeRecordingProcess = null;
      activeRecordingDevice = null;
      activeRecordingFile = null;
      recordingStartTime = null;
      recordingTimer = null;
      if (!isArmedForSound) {
        targetRecordingDevice = null;
        autoSplitEnabled = false;
      }
    }
    broadcastStatus();
    broadcast({ type: 'recordings_list', data: getRecordingsList() });
  }
  return result;
}

async function startRecording(device, metadata = {}) {
  const inputDevice = assertDedicatedInputDevice(device);
  if (activeRecordingContext) {
    await stopRecording();
  }
  if (activeMonitorDevice !== inputDevice) {
    startMonitoring(inputDevice);
  }

  const normalizedMetadata = normalizeTrackMetadata(metadata);
  const id = crypto.randomBytes(4).toString('hex');
  const filename = createTrackFilename({ ...normalizedMetadata, id });
  const tempPath = path.join(STAGING_DIR, `${crypto.randomBytes(12).toString('hex')}.wav`);
  const processSpec = buildCaptureProcessSpec({
    platform: os.platform(),
    device: inputDevice,
    outputPath: tempPath,
    sampleRate: 44100
  });
  const captureProcess = spawn(processSpec.command, processSpec.args);
  const context = {
    process: captureProcess,
    device: inputDevice,
    metadata: normalizedMetadata,
    id,
    filename,
    tempPath,
    startedAt: Date.now(),
    stopRequested: false,
    spawnError: null,
    timer: null,
    forceKillTimer: null,
    completion: null
  };

  activeRecordingContext = context;
  activeRecordingProcess = captureProcess;
  activeRecordingDevice = inputDevice;
  activeRecordingFile = filename;
  recordingStartTime = context.startedAt;
  recordedBytes = 0;

  captureProcess.stderr.on('data', data => {
    console.error('Recording stderr:', data.toString());
  });
  context.completion = waitForChildClose(captureProcess).then(({ code, signal, spawnError }) => {
    context.spawnError = spawnError;
    return finishRecordingContext(context, code, signal);
  });

  context.timer = setInterval(() => {
    if (fs.existsSync(tempPath)) {
      recordedBytes = fs.statSync(tempPath).size;
    }
    broadcast({
      type: 'recording_progress',
      data: {
        filename: context.filename,
        durationSeconds: Math.floor((Date.now() - context.startedAt) / 1000),
        sizeBytes: recordedBytes
      }
    });
  }, 1000);
  recordingTimer = context.timer;

  broadcastStatus();
  return context;
}

async function stopRecording() {
  const context = activeRecordingContext;
  if (!context) return null;
  if (!context.stopRequested) {
    context.stopRequested = true;
    try {
      if (isWindows && context.process.stdin && context.process.stdin.writable) {
        context.process.stdin.write('q\n');
      } else {
        context.process.kill('SIGINT');
      }
    } catch (_error) {
      context.process.kill('SIGTERM');
    }
    context.forceKillTimer = setTimeout(() => {
      if (activeRecordingContext === context) {
        try {
          context.process.kill('SIGKILL');
        } catch (_error) {}
      }
    }, 5000);
    context.forceKillTimer.unref();
    broadcastStatus();
  }
  return context.completion;
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function broadcastStatus() {
  broadcast({
    type: 'status',
    data: {
      monitoring: !!activeMonitorProcess,
      monitoringDevice: activeMonitorDevice,
      recording: !!activeRecordingProcess || isArmedForSound,
      recordingState: activeRecordingContext && activeRecordingContext.stopRequested
        ? 'finalizing'
        : (activeRecordingProcess ? 'recording' : (isArmedForSound ? 'armed' : 'idle')),
      recordingDevice: targetRecordingDevice || activeRecordingDevice,
      recordingFile: activeRecordingFile,
      recordingStartTime: recordingStartTime,
      autoSplitEnabled,
      silenceThresholdDb,
      silenceDurationMs
    }
  });
}

// WebSocket Server Events
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'devices',
    data: listDevices()
  }));
  
  ws.send(JSON.stringify({
    type: 'recordings_list',
    data: getRecordingsList()
  }));
  
  ws.send(JSON.stringify({
    type: 'status',
    data: {
      monitoring: !!activeMonitorProcess,
      monitoringDevice: activeMonitorDevice,
      recording: !!activeRecordingProcess || isArmedForSound,
      recordingState: activeRecordingContext && activeRecordingContext.stopRequested
        ? 'finalizing'
        : (activeRecordingProcess ? 'recording' : (isArmedForSound ? 'armed' : 'idle')),
      recordingDevice: targetRecordingDevice || activeRecordingDevice,
      recordingFile: activeRecordingFile,
      recordingStartTime: recordingStartTime,
      autoSplitEnabled,
      silenceThresholdDb,
      silenceDurationMs
    }
  }));
  
  ws.on('message', async (messageText) => {
    try {
      const msg = JSON.parse(messageText);
      
      switch (msg.command) {
        case 'get_devices':
          ws.send(JSON.stringify({
            type: 'devices',
            data: listDevices()
          }));
          break;
          
        case 'start_monitoring':
          if (msg.params && msg.params.device) {
            startMonitoring(msg.params.device);
          }
          break;
          
        case 'stop_monitoring':
          stopMonitoring();
          break;
          
        case 'start_recording':
          if (msg.params && msg.params.device) {
            targetRecordingDevice = assertDedicatedInputDevice(msg.params.device);
            activeRecordingMetadata = normalizeTrackMetadata({
              artist: msg.params.artist,
              title: msg.params.title
            });
            autoSplitEnabled = !!msg.params.autoSplitEnabled;
            
            if (autoSplitEnabled) {
              const requestedThreshold = Number(msg.params.silenceThresholdDb);
              const requestedDuration = Number(msg.params.silenceDurationMs);
              silenceThresholdDb = Number.isFinite(requestedThreshold)
                ? Math.min(-25, Math.max(-60, requestedThreshold))
                : -45;
              silenceDurationMs = Number.isFinite(requestedDuration)
                ? Math.min(5000, Math.max(500, requestedDuration))
                : 1000;
              silenceThresholdLinear = Math.pow(10, silenceThresholdDb / 20);
              
              if (activeMonitorDevice !== targetRecordingDevice) {
                startMonitoring(targetRecordingDevice);
              }
              
              const maxRms = Math.max(latestLevels.rmsL, latestLevels.rmsR);
              if (maxRms < silenceThresholdLinear) {
                isArmedForSound = true;
                silenceStartTimestamp = null;
                broadcastStatus();
              } else {
                isArmedForSound = false;
                await startRecording(targetRecordingDevice, activeRecordingMetadata);
              }
            } else {
              isArmedForSound = false;
              await startRecording(targetRecordingDevice, activeRecordingMetadata);
            }
          }
          break;
          
        case 'stop_recording':
          isArmedForSound = false;
          autoSplitEnabled = false;
          await stopRecording();
          break;
          
        case 'refresh_recordings':
          ws.send(JSON.stringify({
            type: 'recordings_list',
            data: getRecordingsList()
          }));
          break;
          
        default:
          console.warn('Unknown WebSocket command:', msg.command);
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: err.message || 'Unable to process audio control request' }
      }));
    }
  });
  
  ws.on('close', () => {
    if (wss.clients.size === 0) {
      stopMonitoring();
    }
  });
});

function getAvailablePort(startingPort, host = LOOPBACK_HOST) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.unref();
    tester.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(getAvailablePort(startingPort + 1, host));
      } else {
        reject(err);
      }
    });
    tester.listen(startingPort, host, () => {
      const { port } = tester.address();
      tester.close(() => resolve(port));
    });
  });
}

async function startServer(preferredPort = process.env.PORT || 3000) {
  const targetPort = parseInt(preferredPort, 10);
  const freePort = await getAvailablePort(targetPort);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(freePort, LOOPBACK_HOST, () => {
      console.log(`WaveSentry Pro running at http://${LOOPBACK_HOST}:${freePort}`);
      process.env.WAVESENTRY_PORT = freePort;
      resolve(freePort);
    });
  });
}

if (require.main === module) {
  startServer().catch(err => console.error('Failed to start server:', err));
}

module.exports = {
  app,
  server,
  wss,
  startServer,
  getAvailablePort,
  isAllowedBrowserOrigin,
  LOOPBACK_HOST,
  listDevices,
  listDevicesLinux,
  listDevicesWindows,
  parsePipeWireInputDevices,
  parseWindowsAudioInputDevices,
  getRecordingsList,
  getRecordingMetadata,
  updateRecordingMetadata,
  computeSpectrum,
  isValidFilename,
  RECORDINGS_DIR,
  BREAK_WAVE_PUBLISH_DIR
};
