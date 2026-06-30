const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const os = require('os');
const isWindows = os.platform() === 'win32';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');

// Ensure recordings directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
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

app.delete('/api/recordings/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(RECORDINGS_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      // Broadcast updated list to all clients
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
let latestLevels = { rmsL: 0, rmsR: 0 };

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
          
          let isDefault = false;
          if (name === defaultSink) {
            isDefault = true;
          }
          
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
    
    // Sort: default devices first
    return devices.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.description.localeCompare(b.description);
    });
  } catch (err) {
    console.error('Error listing Linux devices:', err);
    return [];
  }
}

function listDevicesWindows() {
  try {
    let output = '';
    try {
      execSync('ffmpeg -f wasapi -list_devices true -i dummy', { stdio: 'pipe' });
    } catch (err) {
      output = err.stderr ? err.stderr.toString() : (err.message || '');
    }
    
    const devices = [];
    devices.push({
      id: 'Default Render Device',
      name: 'Default Render Device',
      description: 'Default System Output',
      nick: 'Default',
      type: 'output',
      isDefault: true
    });
    
    const lines = output.split('\n');
    let inOutputs = false;
    
    for (const line of lines) {
      if (line.includes('Output devices:')) {
        inOutputs = true;
        continue;
      }
      if (line.includes('Input devices:')) {
        inOutputs = false;
        continue;
      }
      
      if (inOutputs) {
        const match = line.match(/\]\s+"([^"]+)"/);
        if (match) {
          const name = match[1];
          if (name !== 'Default Render Device' && !devices.some(d => d.name === name)) {
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
    console.error('Error listing Windows devices:', err);
    return [{
      id: 'Default Render Device',
      name: 'Default Render Device',
      description: 'Default System Output (Fallback)',
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
    return files
      .filter(file => file.endsWith('.wav'))
      .map(file => {
        const filePath = path.join(RECORDINGS_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          sizeBytes: stats.size,
          createdAt: stats.birthtimeMs || stats.mtimeMs,
          path: `/recordings/${file}`
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    console.error('Error listing recordings:', err);
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

function startMonitoring(device) {
  stopMonitoring();
  activeMonitorDevice = device;
  
  if (isWindows) {
    const target = device === 'Default Render Device' ? 'Default Render Device' : device;
    const targetLoopback = `${target} (loopback)`;
    activeMonitorProcess = spawn('ffmpeg', [
      '-f', 'wasapi',
      '-i', `audio=${targetLoopback}`,
      '-ac', '2',
      '-ar', '16000',
      '-f', 's16le',
      '-y',
      '-'
    ]);
  } else {
    // Format is s16, rate is 16000, 2 channels, output to stdout (-)
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
    const frameSize = 4; // 16-bit stereo = 2 bytes * 2 channels
    const chunkSize = 512 * frameSize; // 512 samples per chunk (32ms at 16kHz)
    
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
      
      latestLevels.rmsL = rmsL;
      latestLevels.rmsR = rmsR;
      
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
          rmsR: rmsR
        }
      });
    }
  });
  
  activeMonitorProcess.on('close', () => {
    activeMonitorProcess = null;
    activeMonitorDevice = null;
    broadcastStatus();
  });
  
  activeMonitorProcess.stderr.on('data', (err) => {
    console.error("Monitor stderr:", err.toString());
  });
}

function startRecording(device, prefix = 'recording') {
  if (activeRecordingProcess) {
    stopRecording();
  }
  
  // Ensure we are monitoring this device to calculate levels and silence detection
  if (activeMonitorDevice !== device) {
    startMonitoring(device);
  }
  
  // Create safe prefix
  const safePrefix = prefix.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'recording';
  const dateStr = new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
  const filename = `${safePrefix}_${dateStr}.wav`;
  const filePath = path.join(RECORDINGS_DIR, filename);
  
  activeRecordingDevice = device;
  activeRecordingFile = filename;
  recordingStartTime = Date.now();
  recordedBytes = 0;
  
  if (isWindows) {
    const target = device === 'Default Render Device' ? 'Default Render Device' : device;
    const targetLoopback = `${target} (loopback)`;
    activeRecordingProcess = spawn('ffmpeg', [
      '-f', 'wasapi',
      '-i', `audio=${targetLoopback}`,
      '-ac', '2',
      '-ar', '44100',
      '-y',
      filePath
    ]);
  } else {
    // Record standard high quality: s16, 44100Hz, stereo
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
  
  // Update progress every second
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
      activeRecordingProcess.kill('SIGTERM'); // Terminate cleanly to save WAV header
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
  // Send initial data to client
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
              
              // Ensure we are monitoring this device to inspect levels
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
    // If no client is active, stop monitoring to conserve resources
    if (wss.clients.size === 0) {
      stopMonitoring();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
