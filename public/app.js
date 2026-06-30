// WebSocket & UI State
let ws = null;
let reconnectTimer = null;
let currentStatus = {
  monitoring: false,
  monitoringDevice: null,
  recording: false,
  recordingDevice: null,
  recordingFile: null,
  recordingStartTime: null
};

// Canvas Setup
const canvas = document.getElementById('waveform-canvas');
const ctx = canvas.getContext('2d');
const amplitudeHistory = [];
const maxHistory = 150;

// Peak Hold Variables for VU meters
let peakHoldL = 0;
let peakHoldR = 0;
const peakDecayRate = 0.015; // Decay rate per update

// Resize Canvas
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}

// Initial Canvas Resize & Listeners
window.addEventListener('resize', resizeCanvas);
// Call after browser rendering has stabilized
setTimeout(resizeCanvas, 100);

// Initialize historical values
for (let i = 0; i < maxHistory; i++) {
  amplitudeHistory.push(0);
}

// Draw Waveform history on Canvas
function drawWaveform(levelL, levelR) {
  const avg = (levelL + levelR) / 2;
  amplitudeHistory.push(avg);
  if (amplitudeHistory.length > maxHistory) {
    amplitudeHistory.shift();
  }
  
  const w = canvas.width / window.devicePixelRatio;
  const h = canvas.height / window.devicePixelRatio;
  
  ctx.clearRect(0, 0, w, h);
  
  // Center line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  
  const barWidth = w / maxHistory;
  const centerY = h / 2;
  
  // Custom glowing gradient
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, '#06B6D4'); // Cyan
  gradient.addColorStop(0.5, '#8B5CF6'); // Purple
  gradient.addColorStop(1, '#06B6D4'); // Cyan
  ctx.fillStyle = gradient;
  
  for (let i = 0; i < amplitudeHistory.length; i++) {
    const val = amplitudeHistory[i]; // 0 to 1
    const x = i * barWidth;
    const barHeight = val * (h - 10);
    const y = centerY - barHeight / 2;
    
    ctx.fillRect(x, y, barWidth - 1, Math.max(1.5, barHeight));
  }
}

// Update VU Meters
function updateVUMeters(peakL, peakR) {
  // Peak Hold Decay
  if (peakL >= peakHoldL) {
    peakHoldL = peakL;
  } else {
    peakHoldL = Math.max(0, peakHoldL - peakDecayRate);
  }
  
  if (peakR >= peakHoldR) {
    peakHoldR = peakR;
  } else {
    peakHoldR = Math.max(0, peakHoldR - peakDecayRate);
  }
  
  // Update widths
  document.getElementById('vu-bar-L').style.width = `${peakL * 100}%`;
  document.getElementById('vu-bar-R').style.width = `${peakR * 100}%`;
  
  // Update ticks
  document.getElementById('vu-peak-L').style.left = `${peakHoldL * 100}%`;
  document.getElementById('vu-peak-R').style.left = `${peakHoldR * 100}%`;
  
  // Calculate dB
  const dbL = peakL > 0.0001 ? Math.round(20 * Math.log10(peakL)) : -Infinity;
  const dbR = peakR > 0.0001 ? Math.round(20 * Math.log10(peakR)) : -Infinity;
  
  const displayL = dbL === -Infinity ? '-∞ dB' : `${dbL} dB`;
  const displayR = dbR === -Infinity ? '-∞ dB' : `${dbR} dB`;
  
  const dbDisplayL = document.getElementById('vu-db-L');
  const dbDisplayR = document.getElementById('vu-db-R');
  
  dbDisplayL.textContent = displayL;
  dbDisplayR.textContent = displayR;
  
  setDbColor(dbDisplayL, dbL);
  setDbColor(dbDisplayR, dbR);
}

function setDbColor(el, db) {
  if (db >= -3) {
    el.style.color = 'var(--vu-red)';
  } else if (db >= -12) {
    el.style.color = 'var(--vu-yellow)';
  } else {
    el.style.color = 'var(--accent-cyan)';
  }
}

// Format Helper Functions
function formatDuration(sec) {
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  return [
    hrs.toString().padStart(2, '0'),
    mins.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0')
  ].join(':');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0.00 MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

// WebSocket Connection
function connectWebSocket() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host || 'localhost:3000'}/api/ws`;
  
  document.getElementById('server-url').textContent = wsUrl;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    document.getElementById('status-dot').className = 'status-dot connected';
    document.getElementById('status-text').textContent = 'CONNECTED';
    clearTimeout(reconnectTimer);
    
    // Enable controls
    document.getElementById('device-select').removeAttribute('disabled');
    document.getElementById('monitor-toggle-btn').removeAttribute('disabled');
    document.getElementById('record-btn').removeAttribute('disabled');
  };
  
  ws.onclose = () => {
    console.warn('WebSocket connection lost, retrying...');
    document.getElementById('status-dot').className = 'status-dot idle';
    document.getElementById('status-text').textContent = 'DISCONNECTED';
    
    // Disable controls
    document.getElementById('device-select').setAttribute('disabled', 'true');
    document.getElementById('monitor-toggle-btn').setAttribute('disabled', 'true');
    document.getElementById('record-btn').setAttribute('disabled', 'true');
    
    // Reset VU meters
    updateVUMeters(0, 0);
    
    // Try to reconnect in 3s
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };
  
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    
    switch (msg.type) {
      case 'devices':
        populateDevices(msg.data);
        break;
        
      case 'recordings_list':
        populateRecordings(msg.data);
        break;
        
      case 'status':
        updateUIStatus(msg.data);
        break;
        
      case 'levels':
        updateVUMeters(msg.data.peakL, msg.data.peakR);
        drawWaveform(msg.data.peakL, msg.data.peakR);
        break;
        
      case 'recording_progress':
        updateRecordingProgress(msg.data);
        break;
    }
  };
}

// Populate Devices Dropdown
function populateDevices(devices) {
  const select = document.getElementById('device-select');
  select.innerHTML = '';
  
  if (devices.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No PipeWire sinks/sources detected';
    opt.disabled = true;
    select.appendChild(opt);
    return;
  }
  
  devices.forEach(dev => {
    const opt = document.createElement('option');
    opt.value = dev.name;
    const typeLabel = dev.type === 'output' ? '🖥️ Output' : '🎤 Input';
    const defaultLabel = dev.isDefault ? ' (Default)' : '';
    opt.textContent = `${typeLabel} - ${dev.description}${defaultLabel}`;
    if (dev.isDefault && !currentStatus.monitoringDevice && !currentStatus.recordingDevice) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

// Update UI Status
function updateUIStatus(status) {
  currentStatus = status;
  const select = document.getElementById('device-select');
  const monitorBtn = document.getElementById('monitor-toggle-btn');
  const monitorText = document.getElementById('monitor-btn-text');
  const recordBtn = document.getElementById('record-btn');
  const recordBtnText = document.getElementById('record-btn-text');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const timerDisplay = document.getElementById('timer-display');
  const recordIndicator = document.getElementById('recording-indicator');
  
  // Set dropdown value
  const activeDevice = status.recordingDevice || status.monitoringDevice;
  if (activeDevice) {
    select.value = activeDevice;
  }
  
  // Update Auto-Split settings fields if they exist in status
  if (status.autoSplitEnabled !== undefined) {
    document.getElementById('auto-split-toggle').checked = status.autoSplitEnabled;
    const sliders = document.getElementById('auto-split-sliders');
    if (status.autoSplitEnabled) {
      sliders.classList.remove('collapsed');
    } else {
      sliders.classList.add('collapsed');
    }
  }
  if (status.silenceThresholdDb !== undefined) {
    document.getElementById('silence-threshold').value = status.silenceThresholdDb;
    document.getElementById('threshold-val').textContent = `${status.silenceThresholdDb} dB`;
  }
  if (status.silenceDurationMs !== undefined) {
    const secs = status.silenceDurationMs / 1000;
    document.getElementById('silence-duration').value = secs;
    document.getElementById('duration-val').textContent = `${secs.toFixed(1)} s`;
  }
  
  // Monitoring State
  if (status.monitoring) {
    monitorBtn.classList.add('active');
    monitorText.textContent = 'Stop Monitor';
    statusDot.className = 'status-dot monitoring';
    statusText.textContent = 'MONITORING';
    select.setAttribute('disabled', 'true');
  } else {
    monitorBtn.classList.remove('active');
    monitorText.textContent = 'Enable Monitor';
    select.removeAttribute('disabled');
  }
  
  // Recording State
  if (status.recording) {
    recordBtn.classList.add('recording');
    recordBtnText.textContent = 'Stop Recording';
    
    if (status.recordingState === 'armed') {
      statusDot.className = 'status-dot monitoring';
      statusText.textContent = 'ARMED (SILENT)';
      recordIndicator.classList.remove('active');
      timerDisplay.textContent = 'WAITING';
      timerDisplay.classList.add('idle');
      timerDisplay.style.color = 'var(--vu-yellow)';
      timerDisplay.style.textShadow = '0 0 10px rgba(245, 158, 11, 0.4)';
    } else {
      statusDot.className = 'status-dot recording';
      statusText.textContent = 'RECORDING';
      recordIndicator.classList.add('active');
      timerDisplay.classList.remove('idle');
      timerDisplay.style.color = 'var(--vu-red)';
      timerDisplay.style.textShadow = '0 0 12px rgba(239, 68, 68, 0.3)';
    }
    
    select.setAttribute('disabled', 'true');
    document.getElementById('filename-prefix').setAttribute('disabled', 'true');
    document.getElementById('auto-split-toggle').setAttribute('disabled', 'true');
    document.getElementById('silence-threshold').setAttribute('disabled', 'true');
    document.getElementById('silence-duration').setAttribute('disabled', 'true');
  } else {
    recordBtn.classList.remove('recording');
    recordBtnText.textContent = 'Start Recording';
    recordIndicator.classList.remove('active');
    timerDisplay.classList.add('idle');
    timerDisplay.style.color = '';
    timerDisplay.style.textShadow = '';
    
    document.getElementById('filename-prefix').removeAttribute('disabled');
    document.getElementById('auto-split-toggle').removeAttribute('disabled');
    document.getElementById('silence-threshold').removeAttribute('disabled');
    document.getElementById('silence-duration').removeAttribute('disabled');
    
    if (!status.monitoring) {
      statusDot.className = 'status-dot connected';
      statusText.textContent = 'CONNECTED';
      timerDisplay.textContent = '00:00:00';
      document.getElementById('record-size').textContent = '0.00 MB';
      updateVUMeters(0, 0);
    }
  }
}

// Update Recording Progress
function updateRecordingProgress(progress) {
  document.getElementById('timer-display').textContent = formatDuration(progress.durationSeconds);
  document.getElementById('record-size').textContent = formatBytes(progress.sizeBytes);
}

// Populate Recordings Library List
let playingFilename = null;
function populateRecordings(recordings) {
  const container = document.getElementById('recordings-list');
  container.innerHTML = '';
  
  if (recordings.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📁</div>
        <p>No recordings found.</p>
        <p class="empty-subtext">Recordings you capture will show up here.</p>
      </div>
    `;
    return;
  }
  
  recordings.forEach(rec => {
    const date = new Date(rec.createdAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const size = formatBytes(rec.sizeBytes);
    const isCurrentlyPlaying = playingFilename === rec.filename;
    
    const div = document.createElement('div');
    div.className = `recording-item ${isCurrentlyPlaying ? 'playing' : ''}`;
    div.innerHTML = `
      <div class="recording-details-left">
        <span class="file-icon">🎵</span>
        <div class="recording-meta">
          <span class="recording-name" title="${rec.filename}">${rec.filename}</span>
          <div class="recording-info-row">
            <span>${date}</span>
            <span>•</span>
            <span>${size}</span>
          </div>
        </div>
      </div>
      <div class="recording-actions-right">
        <button class="btn-action-sm btn-play-sm" title="Play recording">
          <svg viewBox="0 0 24 24">
            <path d="${isCurrentlyPlaying ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z' : 'M8 5v14l11-7z'}"/>
          </svg>
        </button>
        <button class="btn-action-sm btn-delete-sm" title="Delete recording">
          <svg viewBox="0 0 24 24">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        </button>
      </div>
    `;
    
    // Bind click events
    div.querySelector('.btn-play-sm').addEventListener('click', () => {
      playAudio(rec.filename, rec.path);
    });
    
    div.querySelector('.btn-delete-sm').addEventListener('click', () => {
      if (confirm(`Are you sure you want to delete ${rec.filename}?`)) {
        deleteAudio(rec.filename);
      }
    });
    
    container.appendChild(div);
  });
}

// Audio Player Handling
const audio = document.getElementById('library-audio');
const customPlayer = document.getElementById('custom-player');
const playBtn = document.getElementById('player-play-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const seekSlider = document.getElementById('player-progress');
const volSlider = document.getElementById('player-volume');
const currentTimeDisplay = document.getElementById('player-time-current');
const durationTimeDisplay = document.getElementById('player-time-duration');
const playerFilename = document.getElementById('player-filename');
const playerDownloadBtn = document.getElementById('player-download-btn');

function formatMMSS(sec) {
  if (isNaN(sec)) return '00:00';
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function playAudio(filename, path) {
  // If clicking play on already playing, pause it.
  if (playingFilename === filename) {
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
    return;
  }
  
  playingFilename = filename;
  playerFilename.textContent = filename;
  playerFilename.title = filename;
  playerDownloadBtn.href = path;
  playerDownloadBtn.download = filename;
  
  // Show Player Panel
  customPlayer.classList.remove('hidden');
  
  audio.src = path;
  audio.load();
  audio.play()
    .then(() => {
      // Highlight in list
      refreshPlayingListHighlight();
    })
    .catch(err => {
      console.error('Audio playback failed:', err);
    });
}

function refreshPlayingListHighlight() {
  // We can force refresh list view or manually update CSS classes
  const items = document.querySelectorAll('.recording-item');
  items.forEach(item => {
    const name = item.querySelector('.recording-name').textContent;
    const playSvg = item.querySelector('.btn-play-sm svg path');
    
    if (name === playingFilename) {
      item.classList.add('playing');
      // Show pause icon in list item
      if (audio.paused) {
        item.classList.remove('playing');
        playSvg.setAttribute('d', 'M8 5v14l11-7z'); // Play icon
      } else {
        playSvg.setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'); // Pause icon
      }
    } else {
      item.classList.remove('playing');
      playSvg.setAttribute('d', 'M8 5v14l11-7z');
    }
  });
}

// Audio events
audio.onplay = () => {
  playIcon.classList.add('hidden');
  pauseIcon.classList.remove('hidden');
  refreshPlayingListHighlight();
};

audio.onpause = () => {
  playIcon.classList.remove('hidden');
  pauseIcon.classList.add('hidden');
  refreshPlayingListHighlight();
};

audio.onended = () => {
  playingFilename = null;
  customPlayer.classList.add('hidden');
  refreshPlayingListHighlight();
};

audio.ontimeupdate = () => {
  if (audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    seekSlider.value = pct;
    currentTimeDisplay.textContent = formatMMSS(audio.currentTime);
  }
};

audio.onloadedmetadata = () => {
  durationTimeDisplay.textContent = formatMMSS(audio.duration);
  seekSlider.value = 0;
  currentTimeDisplay.textContent = '00:00';
};

// Controls Events
playBtn.addEventListener('click', () => {
  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
});

seekSlider.addEventListener('input', () => {
  if (audio.duration) {
    const targetSec = (seekSlider.value / 100) * audio.duration;
    audio.currentTime = targetSec;
  }
});

volSlider.addEventListener('input', () => {
  audio.volume = volSlider.value / 100;
});

// Delete recording via HTTP endpoint
function deleteAudio(filename) {
  // If we delete what is playing, stop it first
  if (playingFilename === filename) {
    audio.pause();
    playingFilename = null;
    customPlayer.classList.add('hidden');
  }
  
  fetch(`/api/recordings/${encodeURIComponent(filename)}`, {
    method: 'DELETE'
  })
  .then(res => res.json())
  .then(data => {
    if (!data.success) {
      alert('Failed to delete recording: ' + data.error);
    }
  })
  .catch(err => {
    console.error('Delete failed:', err);
    alert('Failed to delete recording.');
  });
}

// User Actions
document.getElementById('monitor-toggle-btn').addEventListener('click', () => {
  const device = document.getElementById('device-select').value;
  if (!device) return;
  
  if (currentStatus.monitoring) {
    ws.send(JSON.stringify({ command: 'stop_monitoring' }));
  } else {
    ws.send(JSON.stringify({
      command: 'start_monitoring',
      params: { device }
    }));
  }
});

// Auto-Split Expand/Collapse
const autoSplitToggle = document.getElementById('auto-split-toggle');
const autoSplitSliders = document.getElementById('auto-split-sliders');
autoSplitToggle.addEventListener('change', () => {
  if (autoSplitToggle.checked) {
    autoSplitSliders.classList.remove('collapsed');
  } else {
    autoSplitSliders.classList.add('collapsed');
  }
});

// Update slider label on user input
const silenceThreshold = document.getElementById('silence-threshold');
const thresholdVal = document.getElementById('threshold-val');
silenceThreshold.addEventListener('input', () => {
  thresholdVal.textContent = `${silenceThreshold.value} dB`;
});

const silenceDuration = document.getElementById('silence-duration');
const durationVal = document.getElementById('duration-val');
silenceDuration.addEventListener('input', () => {
  durationVal.textContent = `${parseFloat(silenceDuration.value).toFixed(1)} s`;
});

document.getElementById('record-btn').addEventListener('click', () => {
  const device = document.getElementById('device-select').value;
  const prefix = document.getElementById('filename-prefix').value;
  if (!device) return;
  
  if (currentStatus.recording) {
    ws.send(JSON.stringify({ command: 'stop_recording' }));
  } else {
    const autoSplitEnabled = autoSplitToggle.checked;
    const silenceThresholdDb = parseFloat(silenceThreshold.value);
    const silenceDurationMs = parseFloat(silenceDuration.value) * 1000;
    
    ws.send(JSON.stringify({
      command: 'start_recording',
      params: { 
        device, 
        prefix,
        autoSplitEnabled,
        silenceThresholdDb,
        silenceDurationMs
      }
    }));
  }
});

document.getElementById('refresh-library-btn').addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ command: 'refresh_recordings' }));
  }
});

// Select device changes
document.getElementById('device-select').addEventListener('change', (e) => {
  const device = e.target.value;
  if (!device) return;
  
  // If currently monitoring, restart monitoring on the new device automatically
  if (currentStatus.monitoring && !currentStatus.recording) {
    ws.send(JSON.stringify({
      command: 'start_monitoring',
      params: { device }
    }));
  }
});

// Setup volume slider default
audio.volume = volSlider.value / 100;

// Start WebSocket on Load
connectWebSocket();
