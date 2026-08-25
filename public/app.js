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

// Visualizer State
let vizMode = 'wave'; // 'wave' or 'fft'
const amplitudeHistory = [];
const maxHistory = 150;
let latestSpectrum = new Array(16).fill(0);
let spectrumPeaks = new Array(16).fill(0);

// Canvas Setup
const canvas = document.getElementById('waveform-canvas');
const ctx = canvas.getContext('2d');

// Peak Hold Variables for VU meters
let peakHoldL = 0;
let peakHoldR = 0;
const peakDecayRate = 0.015;
let clipTimerL = null;
let clipTimerR = null;

// Library state
let allRecordings = [];
let activeTrack = null;
let activeExportFilename = null;

// Resize Canvas
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * (window.devicePixelRatio || 1);
  canvas.height = rect.height * (window.devicePixelRatio || 1);
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
}

window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 100);

for (let i = 0; i < maxHistory; i++) {
  amplitudeHistory.push(0);
}

// Draw Waveform & FFT Spectrum
function drawWaveform(levelL, levelR, spectrum) {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  
  ctx.clearRect(0, 0, w, h);

  if (vizMode === 'fft') {
    drawSpectrumView(w, h, spectrum);
  } else {
    drawOscilloscopeView(w, h, levelL, levelR);
  }
}

function drawOscilloscopeView(w, h, levelL, levelR) {
  const avg = (levelL + levelR) / 2;
  amplitudeHistory.push(avg);
  if (amplitudeHistory.length > maxHistory) {
    amplitudeHistory.shift();
  }

  // Center reference line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  const barWidth = w / maxHistory;
  const centerY = h / 2;

  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, '#06B6D4'); // Cyan
  gradient.addColorStop(0.5, '#8B5CF6'); // Purple
  gradient.addColorStop(1, '#06B6D4'); // Cyan
  ctx.fillStyle = gradient;

  for (let i = 0; i < amplitudeHistory.length; i++) {
    const val = amplitudeHistory[i];
    const x = i * barWidth;
    const barHeight = val * (h - 12);
    const y = centerY - barHeight / 2;
    
    ctx.fillRect(x, y, Math.max(1, barWidth - 1), Math.max(2, barHeight));
  }
}

function drawSpectrumView(w, h, spectrum) {
  const bands = spectrum && spectrum.length > 0 ? spectrum : latestSpectrum;
  const numBands = bands.length || 16;
  const gap = 4;
  const barWidth = (w - (numBands + 1) * gap) / numBands;

  const gradient = ctx.createLinearGradient(0, h, 0, 0);
  gradient.addColorStop(0, '#06B6D4');
  gradient.addColorStop(0.6, '#8B5CF6');
  gradient.addColorStop(1, '#EC4899');

  for (let i = 0; i < numBands; i++) {
    const val = bands[i] || 0;
    const barHeight = Math.max(4, val * (h - 20));
    const x = gap + i * (barWidth + gap);
    const y = h - barHeight - 10;

    if (val >= spectrumPeaks[i]) {
      spectrumPeaks[i] = val;
    } else {
      spectrumPeaks[i] = Math.max(0, spectrumPeaks[i] - 0.02);
    }
    const peakY = h - (spectrumPeaks[i] * (h - 20)) - 10;

    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth, barHeight);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, peakY, barWidth, 2);
  }
}

// Update VU Meters & Clip Indicator
function updateVUMeters(peakL, peakR) {
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
  
  document.getElementById('vu-bar-L').style.width = `${Math.min(100, peakL * 100)}%`;
  document.getElementById('vu-bar-R').style.width = `${Math.min(100, peakR * 100)}%`;
  
  document.getElementById('vu-peak-L').style.left = `${Math.min(100, peakHoldL * 100)}%`;
  document.getElementById('vu-peak-R').style.left = `${Math.min(100, peakHoldR * 100)}%`;
  
  const clipL = document.getElementById('vu-clip-L');
  const clipR = document.getElementById('vu-clip-R');
  if (peakL >= 0.99) {
    clipL.classList.add('active');
    clearTimeout(clipTimerL);
    clipTimerL = setTimeout(() => clipL.classList.remove('active'), 800);
  }
  if (peakR >= 0.99) {
    clipR.classList.add('active');
    clearTimeout(clipTimerR);
    clipTimerR = setTimeout(() => clipR.classList.remove('active'), 800);
  }

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

// Helpers
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
  if (!bytes || bytes === 0) return '0.00 MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

// WebSocket Connection
function connectWebSocket() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host || 'localhost:3000'}/`;
  
  const serverUrlEl = document.getElementById('server-url');
  if (serverUrlEl) serverUrlEl.textContent = wsUrl;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    document.getElementById('status-dot').className = 'status-dot connected';
    document.getElementById('status-text').textContent = 'CONNECTED';
    clearTimeout(reconnectTimer);
    
    document.getElementById('device-select').removeAttribute('disabled');
    document.getElementById('monitor-toggle-btn').removeAttribute('disabled');
    document.getElementById('record-btn').removeAttribute('disabled');
  };
  
  ws.onclose = () => {
    document.getElementById('status-dot').className = 'status-dot idle';
    document.getElementById('status-text').textContent = 'DISCONNECTED';
    
    document.getElementById('device-select').setAttribute('disabled', 'true');
    document.getElementById('monitor-toggle-btn').setAttribute('disabled', 'true');
    document.getElementById('record-btn').setAttribute('disabled', 'true');
    
    updateVUMeters(0, 0);
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };
  
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'devices':
          populateDevices(msg.data);
          break;
        case 'recordings_list':
          allRecordings = msg.data || [];
          renderRecordingsList();
          break;
        case 'status':
          updateStatus(msg.data);
          break;
        case 'levels':
          if (msg.data.spectrum) {
            latestSpectrum = msg.data.spectrum;
          }
          drawWaveform(msg.data.peakL, msg.data.peakR, msg.data.spectrum);
          updateVUMeters(msg.data.peakL, msg.data.peakR);
          break;
        case 'recording_progress':
          document.getElementById('timer-display').textContent = formatDuration(msg.data.durationSeconds);
          document.getElementById('record-size').textContent = formatBytes(msg.data.sizeBytes);
          break;
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  };
}

function populateDevices(devices) {
  const select = document.getElementById('device-select');
  select.innerHTML = '';
  
  if (!devices || devices.length === 0) {
    select.innerHTML = '<option value="" disabled selected>No audio sinks detected</option>';
    return;
  }
  
  devices.forEach(dev => {
    const opt = document.createElement('option');
    opt.value = dev.id || dev.name;
    opt.textContent = `${dev.description} ${dev.isDefault ? '(Default)' : ''}`;
    if (dev.isDefault) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

function updateStatus(status) {
  currentStatus = status;
  
  const monitorBtn = document.getElementById('monitor-toggle-btn');
  const monitorBtnText = document.getElementById('monitor-btn-text');
  if (status.monitoring) {
    monitorBtn.classList.add('active');
    monitorBtnText.textContent = 'Monitoring Active (M)';
  } else {
    monitorBtn.classList.remove('active');
    monitorBtnText.textContent = 'Enable Monitor (M)';
    updateVUMeters(0, 0);
  }
  
  const recordBtn = document.getElementById('record-btn');
  const recordBtnText = document.getElementById('record-btn-text');
  const recordIndicator = document.getElementById('recording-indicator');
  
  if (status.recording) {
    if (status.recordingState === 'armed') {
      recordBtn.className = 'btn btn-record armed';
      recordBtnText.textContent = 'Armed: Waiting for Sound...';
      recordIndicator.className = 'recording-indicator-pulse armed';
    } else {
      recordBtn.className = 'btn btn-record recording';
      recordBtnText.textContent = 'Stop Recording (Space)';
      recordIndicator.className = 'recording-indicator-pulse active';
    }
  } else {
    recordBtn.className = 'btn btn-record';
    recordBtnText.textContent = 'Start Recording (Space)';
    recordIndicator.className = 'recording-indicator-pulse';
    document.getElementById('timer-display').textContent = '00:00:00';
    document.getElementById('record-size').textContent = '0.00 MB';
  }
}

// Render Library with Search & Filtering
function renderRecordingsList() {
  const list = document.getElementById('recordings-list');
  const query = (document.getElementById('library-search').value || '').trim().toLowerCase();
  
  const filtered = allRecordings.filter(rec => {
    if (!query) return true;
    const matchName = rec.filename.toLowerCase().includes(query);
    const matchTitle = (rec.title || '').toLowerCase().includes(query);
    const matchArtist = (rec.artist || '').toLowerCase().includes(query);
    const matchTags = (rec.tags || []).some(t => t.toLowerCase().includes(query));
    return matchName || matchTitle || matchArtist || matchTags;
  });

  const countBadge = document.getElementById('library-count-badge');
  if (countBadge) countBadge.textContent = `${filtered.length} tracks`;

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📁</div>
        <p>${query ? 'No matching recordings found' : 'No recordings yet.'}</p>
        <p class="empty-subtext">${query ? 'Try a different search keyword.' : 'Captured system audio files will appear here.'}</p>
      </div>
    `;
    return;
  }

  list.innerHTML = '';
  filtered.forEach(rec => {
    const item = document.createElement('div');
    item.className = `recording-item ${activeTrack && activeTrack.filename === rec.filename ? 'active' : ''}`;
    
    const dateStr = new Date(rec.createdAt).toLocaleDateString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const tagsHtml = (rec.tags || []).map(t => `<span class="track-tag">${escapeHtml(t)}</span>`).join('');

    item.innerHTML = `
      <div class="rec-icon-col">
        <button class="btn-item-play" title="Play Track">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
      <div class="rec-info-col">
        <div class="rec-title-row">
          <span class="rec-title">${escapeHtml(rec.title || rec.filename)}</span>
          ${rec.favorite ? '<span class="rec-star">★</span>' : ''}
        </div>
        <div class="rec-meta-row">
          <span class="rec-artist">${escapeHtml(rec.artist || 'System Audio')}</span>
          <span class="rec-divider">•</span>
          <span class="rec-date">${dateStr}</span>
          <span class="rec-divider">•</span>
          <span class="rec-size">${formatBytes(rec.sizeBytes)}</span>
        </div>
        ${tagsHtml ? `<div class="rec-tags-row">${tagsHtml}</div>` : ''}
      </div>
      <div class="rec-actions-col">
        <button class="btn-rec-action edit-meta-btn" title="Edit Metadata & Tags">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="btn-rec-action export-btn" title="Export / Transcode">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </button>
        <button class="btn-rec-action delete-btn" title="Delete Recording">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    `;

    item.querySelector('.btn-item-play').addEventListener('click', (e) => {
      e.stopPropagation();
      playTrack(rec);
    });
    item.addEventListener('click', () => playTrack(rec));

    item.querySelector('.edit-meta-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openMetadataModal(rec);
    });

    item.querySelector('.export-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openExportModal(rec);
    });

    item.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${rec.title || rec.filename}"?`)) {
        await deleteRecording(rec.filename);
      }
    });

    list.appendChild(item);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

// Audio Player Handling
const audio = document.getElementById('library-audio');
const playerPanel = document.getElementById('custom-player');
const playerPlayBtn = document.getElementById('player-play-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const playerProgress = document.getElementById('player-progress');
const playerTimeCurrent = document.getElementById('player-time-current');
const playerTimeDuration = document.getElementById('player-time-duration');
const playerVolume = document.getElementById('player-volume');
const playerSpeed = document.getElementById('player-speed');

function playTrack(rec) {
  activeTrack = rec;
  playerPanel.classList.remove('hidden');
  document.getElementById('player-title').textContent = rec.title || rec.filename;
  document.getElementById('player-artist').textContent = rec.artist || 'System Audio';
  document.getElementById('player-filename').textContent = rec.filename;

  audio.src = `/recordings/${rec.filename}`;
  audio.playbackRate = parseFloat(playerSpeed.value) || 1.0;
  audio.play();
  playIcon.classList.add('hidden');
  pauseIcon.classList.remove('hidden');
  renderRecordingsList();
}

playerPlayBtn.addEventListener('click', () => {
  if (audio.paused) {
    audio.play();
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
  } else {
    audio.pause();
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
  }
});

document.getElementById('player-skip-back').addEventListener('click', () => {
  audio.currentTime = Math.max(0, audio.currentTime - 5);
});

document.getElementById('player-skip-forward').addEventListener('click', () => {
  audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
});

playerSpeed.addEventListener('change', () => {
  audio.playbackRate = parseFloat(playerSpeed.value) || 1.0;
});

audio.addEventListener('timeupdate', () => {
  if (audio.duration) {
    const progress = (audio.currentTime / audio.duration) * 100;
    playerProgress.value = progress;
    playerTimeCurrent.textContent = formatDuration(Math.floor(audio.currentTime)).slice(3);
    playerTimeDuration.textContent = formatDuration(Math.floor(audio.duration)).slice(3);
  }
});

playerProgress.addEventListener('input', () => {
  if (audio.duration) {
    audio.currentTime = (playerProgress.value / 100) * audio.duration;
  }
});

playerVolume.addEventListener('input', () => {
  audio.volume = playerVolume.value / 100;
});

audio.addEventListener('ended', () => {
  playIcon.classList.remove('hidden');
  pauseIcon.classList.add('hidden');
});

// Export Modal
function openExportModal(rec) {
  activeExportFilename = rec.filename;
  document.getElementById('export-target-filename').textContent = rec.title || rec.filename;
  document.getElementById('export-modal').classList.remove('hidden');
}

document.getElementById('export-modal-close').addEventListener('click', () => {
  document.getElementById('export-modal').classList.add('hidden');
});
document.getElementById('export-cancel-btn').addEventListener('click', () => {
  document.getElementById('export-modal').classList.add('hidden');
});

document.getElementById('export-confirm-btn').addEventListener('click', () => {
  if (!activeExportFilename) return;
  const format = document.querySelector('input[name="export-format"]:checked').value;
  const bitrate = document.getElementById('export-bitrate').value;
  
  const exportUrl = `/api/recordings/${encodeURIComponent(activeExportFilename)}/export?format=${format}&bitrate=${bitrate}`;
  
  const a = document.createElement('a');
  a.href = exportUrl;
  a.download = `${activeExportFilename.replace(/\.[^/.]+$/, '')}.${format === 'aac' ? 'm4a' : format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  
  document.getElementById('export-modal').classList.add('hidden');
});

document.getElementById('player-export-btn').addEventListener('click', () => {
  if (activeTrack) {
    openExportModal(activeTrack);
  }
});

// Metadata Modal
function openMetadataModal(rec) {
  document.getElementById('meta-filename').value = rec.filename;
  document.getElementById('meta-title').value = rec.title || '';
  document.getElementById('meta-artist').value = rec.artist || '';
  document.getElementById('meta-tags').value = (rec.tags || []).join(', ');
  document.getElementById('meta-notes').value = rec.notes || '';
  document.getElementById('metadata-modal').classList.remove('hidden');
}

document.getElementById('metadata-modal-close').addEventListener('click', () => {
  document.getElementById('metadata-modal').classList.add('hidden');
});
document.getElementById('metadata-cancel-btn').addEventListener('click', () => {
  document.getElementById('metadata-modal').classList.add('hidden');
});

document.getElementById('metadata-save-btn').addEventListener('click', async () => {
  const filename = document.getElementById('meta-filename').value;
  const title = document.getElementById('meta-title').value;
  const artist = document.getElementById('meta-artist').value;
  const rawTags = document.getElementById('meta-tags').value;
  const notes = document.getElementById('meta-notes').value;
  
  const tags = rawTags.split(',').map(t => t.trim()).filter(Boolean);

  try {
    const res = await fetch(`/api/recordings/${encodeURIComponent(filename)}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, artist, tags, notes })
    });
    if (res.ok) {
      document.getElementById('metadata-modal').classList.add('hidden');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ command: 'refresh_recordings' }));
      }
    }
  } catch (err) {
    console.error('Failed to save metadata:', err);
  }
});

// Delete recording
async function deleteRecording(filename) {
  try {
    const res = await fetch(`/api/recordings/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (res.ok) {
      if (activeTrack && activeTrack.filename === filename) {
        audio.pause();
        playerPanel.classList.add('hidden');
        activeTrack = null;
      }
    }
  } catch (err) {
    console.error('Error deleting recording:', err);
  }
}

// Visualizer Mode Toggles
document.getElementById('viz-mode-wave').addEventListener('click', () => {
  vizMode = 'wave';
  document.getElementById('viz-mode-wave').classList.add('active');
  document.getElementById('viz-mode-fft').classList.remove('active');
});

document.getElementById('viz-mode-fft').addEventListener('click', () => {
  vizMode = 'fft';
  document.getElementById('viz-mode-fft').classList.add('active');
  document.getElementById('viz-mode-wave').classList.remove('active');
});

// Auto-Split Toggle
const autoSplitToggle = document.getElementById('auto-split-toggle');
const autoSplitSliders = document.getElementById('auto-split-sliders');
autoSplitToggle.addEventListener('change', () => {
  if (autoSplitToggle.checked) {
    autoSplitSliders.classList.remove('collapsed');
  } else {
    autoSplitSliders.classList.add('collapsed');
  }
});

const thresholdSlider = document.getElementById('silence-threshold');
const thresholdVal = document.getElementById('threshold-val');
thresholdSlider.addEventListener('input', () => {
  thresholdVal.textContent = `${thresholdSlider.value} dB`;
});

const durationSlider = document.getElementById('silence-duration');
const durationVal = document.getElementById('duration-val');
durationSlider.addEventListener('input', () => {
  durationVal.textContent = `${Number(durationSlider.value).toFixed(1)} s`;
});

// Library search filter
document.getElementById('library-search').addEventListener('input', renderRecordingsList);
document.getElementById('refresh-library-btn').addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ command: 'refresh_recordings' }));
  }
});

// Monitor & Record actions
const monitorToggleBtn = document.getElementById('monitor-toggle-btn');
monitorToggleBtn.addEventListener('click', () => {
  const deviceSelect = document.getElementById('device-select');
  const selectedDevice = deviceSelect.value;
  if (!selectedDevice) return;

  if (currentStatus.monitoring) {
    ws.send(JSON.stringify({ command: 'stop_monitoring' }));
  } else {
    ws.send(JSON.stringify({
      command: 'start_monitoring',
      params: { device: selectedDevice }
    }));
  }
});

const recordBtn = document.getElementById('record-btn');
recordBtn.addEventListener('click', toggleRecording);

function toggleRecording() {
  const deviceSelect = document.getElementById('device-select');
  const selectedDevice = deviceSelect.value;
  if (!selectedDevice) return;

  if (currentStatus.recording) {
    ws.send(JSON.stringify({ command: 'stop_recording' }));
  } else {
    const prefix = document.getElementById('filename-prefix').value || 'sys_output';
    const autoSplit = autoSplitToggle.checked;
    const thresh = thresholdSlider.value;
    const dur = durationSlider.value * 1000;

    ws.send(JSON.stringify({
      command: 'start_recording',
      params: {
        device: selectedDevice,
        prefix: prefix,
        autoSplitEnabled: autoSplit,
        silenceThresholdDb: thresh,
        silenceDurationMs: dur
      }
    }));
  }
}

// Shortcuts modal
const shortcutsModal = document.getElementById('shortcuts-modal');
document.getElementById('shortcuts-btn').addEventListener('click', () => {
  shortcutsModal.classList.remove('hidden');
});
document.getElementById('shortcuts-modal-close').addEventListener('click', () => {
  shortcutsModal.classList.add('hidden');
});
document.getElementById('shortcuts-close-btn').addEventListener('click', () => {
  shortcutsModal.classList.add('hidden');
});

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    if (e.key === 'Escape') {
      e.target.blur();
    }
    return;
  }

  if (e.key === ' ' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
    e.preventDefault();
    toggleRecording();
  } else if (e.key.toLowerCase() === 'm') {
    e.preventDefault();
    monitorToggleBtn.click();
  } else if (e.key.toLowerCase() === 'v') {
    e.preventDefault();
    if (vizMode === 'wave') {
      document.getElementById('viz-mode-fft').click();
    } else {
      document.getElementById('viz-mode-wave').click();
    }
  } else if (e.key.toLowerCase() === 'p') {
    e.preventDefault();
    playerPlayBtn.click();
  } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
    e.preventDefault();
    shortcutsModal.classList.toggle('hidden');
  } else if (e.key === 'Escape') {
    document.getElementById('export-modal').classList.add('hidden');
    document.getElementById('metadata-modal').classList.add('hidden');
    shortcutsModal.classList.add('hidden');
  }
});

connectWebSocket();
