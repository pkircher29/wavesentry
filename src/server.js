const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execSync } = require('child_process');
const os = require('os');
const isWindows = os.platform() === 'win32';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

let RECORDINGS_DIR;
try {
  const { app: electronApp } = require('electron');
  if (electronApp && typeof electronApp.getPath === 'function') {
    RECORDINGS_DIR = path.join(electronApp.getPath('userData'), 'recordings');
  }
} catch (e) {
  // Not in Electron process
}

if (!RECORDINGS_DIR) {
  RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'recordings');
}

const METADATA_FILE = path.join(RECORDINGS_DIR, '.metadata.json');

// Ensure recordings directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
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
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(meta, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing metadata file:', err.message);
    return false;
  }
}

function getRecordingMetadata(filename) {
  const all = loadAllMetadata();
  return all[filename] || {
    title: filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' '),
    artist: 'System Audio',
    tags: [],
    notes: '',
    favorite: false,
    updatedAt: Date.now()
  };
}

function updateRecordingMetadata(filename, updates) {
  const all = loadAllMetadata();
  const current = all[filename] || {
    title: filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' '),
    artist: 'System Audio',
    tags: [],
    notes: '',
    favorite: false
  };

  all[filename] = {
    ...current,
    ...updates,
    updatedAt: Date.now()
  };
  saveAllMetadata(all);
  return all[filename];
}

function isValidFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;
  return /^[a-zA-Z0-9_.\-\s]+$/.test(filename);
}

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve recordings statically
app.use('/recordings', express.static(RECORDINGS_DIR));

// Parse JSON request body
app.use(express.json());

// API Endpoints
app.get('/api/devices', (req, res) => {
  res.json(listDevices());
});

app.get('/api/recordings', (req, res) => {
  res.json(getRecordingsList());
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

// Auto-split / Silence detection configuration & state
let targetRecordingDevice = null;
let activeRecordingPrefix = 'recording';
let autoSplitEnabled = false;
let silenceThresholdDb = -45;
let silenceThresholdLinear = Math.pow(10, -45 / 20);
let silenceDurationMs = 1000;
let silenceStartTimestamp = null;
let isArmedForSound = false;
let latestLevels = { rmsL: 0, rmsR: 0, peakL: 0, peakR: 0, spectrum: [] };

function getDefaultSink() {
  try {
    const out = execSync('wpctl inspect @DEFAULT_SINK@', { encoding: 'utf8' });
    const match = out.match(/node\.name\s*=\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function listDevicesLinux() {
  try {
    const dump = JSON.parse(execSync('pw-dump', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
    const defaultSink = getDefaultSink();
    const devices = [];
    
    for (const obj of dump) {
      if (obj.info && obj.info.props && obj.info.props['media.class']) {
        const mediaClass = obj.info.props['media.class'];
        if (mediaClass === 'Audio/Sink') {
          const name = obj.info.props['node.name'];
          const description = obj.info.props['node.description'] || name;
          const nick = obj.info.props['node.nick'] || '';
          
          let isDefault = (name === defaultSink);
          
          devices.push({
            id: name,
            name: name,
            description: description,
            nick: nick,
            type: 'output',
            isDefault: isDefault
          });
        }
      }
    }
    
    return devices.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.description.localeCompare(b.description);
    });
  } catch (err) {
    console.error('Error listing Linux devices:', err.message);
    return [{
      id: 'default',
      name: 'Default Audio Sink',
      description: 'Default System Audio Sink',
      nick: 'Default',
      type: 'output',
      isDefault: true
    }];
  }
}

function listDevicesWindows() {
  try {
    let output = '';
    try {
      execSync('ffmpeg -f dshow -list_devices true -i dummy', { stdio: 'pipe' });
    } catch (err) {
      output = err.stderr ? err.stderr.toString() : (err.message || '');
    }
    
    const devices = [{
      id: 'virtual-audio-capturer',
      name: 'virtual-audio-capturer',
      description: 'Default Loopback (virtual-audio-capturer)',
      nick: 'Default',
      type: 'output',
      isDefault: true
    }];
    
    const lines = output.split('\n');
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
          if (!name.includes('Alternative name') && !devices.some(d => d.name === name)) {
            devices.push({
              id: name,
              name: name,
              description: name,
              nick: name,
              type: 'output',
              isDefault: false
            });
          }
        }
      }
    }
    return devices;
  } catch (err) {
    console.error('Error listing Windows devices:', err.message);
    return [{
      id: 'virtual-audio-capturer',
      name: 'virtual-audio-capturer',
      description: 'Default Audio Output',
      nick: 'Default',
      type: 'output',
      isDefault: true
    }];
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
          artist: meta.artist || 'System Audio',
          tags: meta.tags || [],
          notes: meta.notes || '',
          favorite: Boolean(meta.favorite)
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
  activeMonitorDevice = device;
  
  if (isWindows) {
    const target = device === 'virtual-audio-capturer' ? 'virtual-audio-capturer' : device;
    activeMonitorProcess = spawn('ffmpeg', [
      '-f', 'dshow',
      '-i', `audio=${target}`,
      '-ac', '2',
      '-ar', '16000',
      '-f', 's16le',
      '-y',
      '-'
    ]);
  } else {
    activeMonitorProcess = spawn('pw-record', [
      '--properties', 'stream.capture.sink=true',
      '--target', device,
      '--format', 's16',
      '--rate', '16000',
      '--channels', '2',
      '-'
    ]);
  }
  
  let buffer = Buffer.alloc(0);
  
  activeMonitorProcess.stdout.on('data', (chunk) => {
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
              stopRecording();
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
            startRecording(targetRecordingDevice, activeRecordingPrefix);
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
  
  activeMonitorProcess.on('close', () => {
    activeMonitorProcess = null;
    activeMonitorDevice = null;
    broadcastStatus();
  });
  
  activeMonitorProcess.stderr.on('data', () => {});
}

function startRecording(device, prefix = 'recording') {
  if (activeRecordingProcess) {
    stopRecording();
  }
  
  if (activeMonitorDevice !== device) {
    startMonitoring(device);
  }
  
  const safePrefix = prefix.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'recording';
  const dateStr = new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
  const filename = `${safePrefix}_${dateStr}.wav`;
  const filePath = path.join(RECORDINGS_DIR, filename);
  
  activeRecordingDevice = device;
  activeRecordingFile = filename;
  recordingStartTime = Date.now();
  recordedBytes = 0;
  
  if (isWindows) {
    const target = device === 'virtual-audio-capturer' ? 'virtual-audio-capturer' : device;
    activeRecordingProcess = spawn('ffmpeg', [
      '-f', 'dshow',
      '-i', `audio=${target}`,
      '-ac', '2',
      '-ar', '44100',
      '-y',
      filePath
    ]);
  } else {
    activeRecordingProcess = spawn('pw-record', [
      '--properties', 'stream.capture.sink=true',
      '--target', device,
      '--format', 's16',
      '--rate', '44100',
      '--channels', '2',
      filePath
    ]);
  }

  activeRecordingProcess.stderr.on('data', (err) => {
    console.error("Recording stderr:", err.toString());
  });
  
  recordingTimer = setInterval(() => {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      recordedBytes = stats.size;
    }
    broadcast({
      type: 'recording_progress',
      data: {
        filename: activeRecordingFile,
        durationSeconds: Math.floor((Date.now() - recordingStartTime) / 1000),
        sizeBytes: recordedBytes
      }
    });
  }, 1000);
  
  activeRecordingProcess.on('close', () => {
    clearInterval(recordingTimer);
    activeRecordingProcess = null;
    activeRecordingDevice = null;
    activeRecordingFile = null;
    recordingStartTime = null;
    
    if (!isArmedForSound) {
      targetRecordingDevice = null;
      autoSplitEnabled = false;
    }
    
    broadcastStatus();
    broadcast({
      type: 'recordings_list',
      data: getRecordingsList()
    });
  });
  
  broadcastStatus();
}

function stopRecording() {
  if (activeRecordingProcess) {
    try {
      activeRecordingProcess.kill('SIGTERM');
    } catch (e) {}
    activeRecordingProcess = null;
  }
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
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
      recordingState: activeRecordingProcess ? 'recording' : (isArmedForSound ? 'armed' : 'idle'),
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
      recordingState: activeRecordingProcess ? 'recording' : (isArmedForSound ? 'armed' : 'idle'),
      recordingDevice: targetRecordingDevice || activeRecordingDevice,
      recordingFile: activeRecordingFile,
      recordingStartTime: recordingStartTime,
      autoSplitEnabled,
      silenceThresholdDb,
      silenceDurationMs
    }
  }));
  
  ws.on('message', (messageText) => {
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
            targetRecordingDevice = msg.params.device;
            activeRecordingPrefix = msg.params.prefix || 'recording';
            autoSplitEnabled = !!msg.params.autoSplitEnabled;
            
            if (autoSplitEnabled) {
              silenceThresholdDb = Number(msg.params.silenceThresholdDb) || -45;
              silenceDurationMs = Number(msg.params.silenceDurationMs) || 1000;
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
                startRecording(targetRecordingDevice, activeRecordingPrefix);
              }
            } else {
              isArmedForSound = false;
              startRecording(targetRecordingDevice, activeRecordingPrefix);
            }
          }
          break;
          
        case 'stop_recording':
          isArmedForSound = false;
          autoSplitEnabled = false;
          stopRecording();
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
    }
  });
  
  ws.on('close', () => {
    if (wss.clients.size === 0) {
      stopMonitoring();
    }
  });
});

function getAvailablePort(startingPort) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.unref();
    tester.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(getAvailablePort(startingPort + 1));
      } else {
        reject(err);
      }
    });
    tester.listen(startingPort, () => {
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
    server.listen(freePort, () => {
      console.log(`WaveSentry Pro running at http://localhost:${freePort}`);
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
  listDevices,
  listDevicesLinux,
  listDevicesWindows,
  getRecordingsList,
  getRecordingMetadata,
  updateRecordingMetadata,
  computeSpectrum,
  isValidFilename,
  RECORDINGS_DIR
};
