// WebSocket & UI State
let ws = null;
let reconnectTimer = null;
let currentStatus = {
  monitoring: false,
  monitoringDevice: null,
  recording: false,
  recordingState: 'idle',
  recordingDevice: null,
  recordingFile: null,
  recordingStartTime: null
};

// Visualizer State
let vizMode = 'wave'; // 'wave' or 'fft'
const maxHistory = 150;
const amplitudeHistory = new Array(maxHistory).fill(0);
let latestSpectrum = new Array(16).fill(0);
let spectrumPeaks = new Array(16).fill(0);
let latestPeakL = 0;
let latestPeakR = 0;

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
let activeFilter = 'all'; // 'all', 'favorites', 'eligible'
let activeTrack = null;
let activeExportFilename = null;
let pendingDeleteRecording = null;
let integrationStatus = { breakWavePublishConfigured: false };

const FFT_LABELS = ['32', '48', '64', '96', '125', '180', '250', '375', '500', '750', '1k', '1.5k', '2k', '4k', '8k', '16k'];

// Resize Canvas safely without compounding ctx.scale
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderAnalyzerFrame(latestPeakL, latestPeakR, latestSpectrum, false);
}

window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 60);

function drawStudioGraticule(w, h) {
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
  ctx.lineWidth = 1;

  const horizontalSteps = [0.2, 0.5, 0.8];
  for (const ratio of horizontalSteps) {
    const y = Math.round(h * ratio) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const verticalDivisions = 8;
  for (let i = 1; i < verticalDivisions; i++) {
    const x = Math.round((w / verticalDivisions) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

function drawWaveform(levelL, levelR, spectrum) {
  latestPeakL = levelL || 0;
  latestPeakR = levelR || 0;
  renderAnalyzerFrame(latestPeakL, latestPeakR, spectrum, true);
}

function renderAnalyzerFrame(levelL, levelR, spectrum, advanceHistory = true) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  if (!w || !h) return;

  ctx.clearRect(0, 0, w, h);
  drawStudioGraticule(w, h);

  if (vizMode === 'fft') {
    drawSpectrumView(w, h, spectrum, advanceHistory);
  } else {
    drawOscilloscopeView(w, h, levelL, levelR, advanceHistory);
  }
}

function drawOscilloscopeView(w, h, levelL, levelR, advanceHistory) {
  if (advanceHistory) {
    const avg = (levelL + levelR) / 2;
    amplitudeHistory.push(avg);
    if (amplitudeHistory.length > maxHistory) {
      amplitudeHistory.shift();
    }
  }

  // Center 0 dB axis line
  const centerY = Math.round(h / 2) + 0.5;
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(w, centerY);
  ctx.stroke();

  const barWidth = w / maxHistory;
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, '#38bdf8');
  gradient.addColorStop(0.5, '#10b981');
  gradient.addColorStop(1, '#38bdf8');
  ctx.fillStyle = gradient;

  for (let i = 0; i < amplitudeHistory.length; i++) {
    const val = amplitudeHistory[i];
    const x = i * barWidth;
    const barHeight = Math.max(2, val * (h - 14));
    const y = (h / 2) - (barHeight / 2);
    ctx.fillRect(x, y, Math.max(1.2, barWidth - 1), barHeight);
  }
}

function drawSpectrumView(w, h, spectrum, advanceHistory) {
  const bands = spectrum && spectrum.length > 0 ? spectrum : latestSpectrum;
  const numBands = bands.length || 16;
  const gap = 5;
  const bottomReserved = 16;
  const usableHeight = Math.max(20, h - bottomReserved - 8);
  const barWidth = (w - (numBands + 1) * gap) / numBands;

  const gradient = ctx.createLinearGradient(0, h - bottomReserved, 0, 6);
  gradient.addColorStop(0, '#0ea5e9');
  gradient.addColorStop(0.65, '#10b981');
  gradient.addColorStop(0.9, '#f59e0b');
  gradient.addColorStop(1, '#ef4444');

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';

  for (let i = 0; i < numBands; i++) {
    const val = bands[i] || 0;
    const barHeight = Math.max(3, val * usableHeight);
    const x = gap + i * (barWidth + gap);
    const y = h - bottomReserved - barHeight;

    if (advanceHistory) {
      if (val >= spectrumPeaks[i]) {
        spectrumPeaks[i] = val;
      } else {
        spectrumPeaks[i] = Math.max(0, spectrumPeaks[i] - 0.018);
      }
    }
    const peakY = h - bottomReserved - (spectrumPeaks[i] * usableHeight);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(x, 6, barWidth, usableHeight);

    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth, barHeight);

    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(x, Math.max(4, peakY - 2), barWidth, 2);

    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.fillText(FFT_LABELS[i] || '', x + barWidth / 2, h - 4);
  }
}

// Update VU Meters & Clip Indicator
function updateVUMeters(peakL, peakR) {
  if (peakL === 0 && peakR === 0 && !currentStatus.monitoring && !currentStatus.recording) {
    peakHoldL = 0;
    peakHoldR = 0;
  } else {
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
    clipTimerL = setTimeout(() => clipL.classList.remove('active'), 1500);
  }
  if (peakR >= 0.99) {
    clipR.classList.add('active');
    clearTimeout(clipTimerR);
    clipTimerR = setTimeout(() => clipR.classList.remove('active'), 1500);
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

document.getElementById('vu-clip-L').addEventListener('click', (e) => {
  clearTimeout(clipTimerL);
  e.currentTarget.classList.remove('active');
});
document.getElementById('vu-clip-R').addEventListener('click', (e) => {
  clearTimeout(clipTimerR);
  e.currentTarget.classList.remove('active');
});

// Formatting Helpers
function formatDuration(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [
    hrs.toString().padStart(2, '0'),
    mins.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0')
  ].join(':');
}

function formatTrackTime(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0.00 MB';
  if (bytes < 1024 * 100) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

// Non-blocking Studio Toast Notification System
function showMessage(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-item ${isError ? 'toast-error' : 'toast-success'}`;
  toast.innerHTML = `
    <span class="toast-indicator" aria-hidden="true"></span>
    <span class="toast-text">${escapeHtml(message)}</span>
    <button class="toast-close" type="button" aria-label="Dismiss notification">&times;</button>
  `;

  const dismiss = () => {
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), 180);
  };

  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  container.appendChild(toast);

  setTimeout(dismiss, isError ? 6000 : 4000);
}

function updateIntegrationBadge() {
  const badge = document.getElementById('integration-badge');
  const badgeText = document.getElementById('integration-badge-text');
  if (!badge || !badgeText) return;

  if (integrationStatus.breakWavePublishConfigured) {
    badge.className = 'integration-badge configured';
    badge.title = 'Auto-KJ Break-Wave directory is configured on the server';
    badgeText.textContent = 'Break-Wave: Ready';
  } else {
    badge.className = 'integration-badge unconfigured';
    badge.title = 'Set BREAK_WAVE_PUBLISH_DIR on the server to enable one-click Auto-KJ Break-Wave handoff';
    badgeText.textContent = 'Break-Wave: Unconfigured';
  }
}

async function loadIntegrationStatus() {
  try {
    const response = await fetch('/api/integration');
    if (!response.ok) throw new Error('Integration status unavailable');
    integrationStatus = await response.json();
  } catch (error) {
    integrationStatus = { breakWavePublishConfigured: false };
    console.error('Unable to load Break-Wave integration status:', error);
  }
  updateIntegrationBadge();
  renderRecordingsList();
}

// WebSocket Connection
function connectWebSocket() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host || '127.0.0.1:3000'}/`;

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
    void loadIntegrationStatus();
  };

  ws.onclose = () => {
    document.getElementById('status-dot').className = 'status-dot idle';
    document.getElementById('status-text').textContent = 'DISCONNECTED';

    document.getElementById('device-select').setAttribute('disabled', 'true');
    document.getElementById('monitor-toggle-btn').setAttribute('disabled', 'true');
    document.getElementById('record-btn').setAttribute('disabled', 'true');

    updateVUMeters(0, 0);
    amplitudeHistory.fill(0);
    spectrumPeaks.fill(0);
    renderAnalyzerFrame(0, 0, latestSpectrum, false);
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
          syncActiveTrackMetadata();
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
        case 'recording_complete':
          showMessage(`Saved owned recording: ${msg.data.filename}`);
          break;
        case 'error':
          showMessage(msg.data && msg.data.message ? msg.data.message : 'Audio operation failed', true);
          break;
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  };
}

function populateDevices(devices) {
  const select = document.getElementById('device-select');
  const previousValue = select.value || currentStatus.recordingDevice || currentStatus.monitoringDevice;
  select.innerHTML = '';

  if (!devices || devices.length === 0) {
    select.innerHTML = '<option value="" disabled selected>No dedicated audio inputs detected</option>';
    return;
  }

  let matchedPrevious = false;
  devices.forEach(dev => {
    const opt = document.createElement('option');
    const id = dev.id || dev.name;
    opt.value = id;
    opt.textContent = `${dev.description}${dev.isDefault ? ' (Default)' : ''}`;
    if (previousValue && id === previousValue) {
      opt.selected = true;
      matchedPrevious = true;
    } else if (!previousValue && dev.isDefault) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  if (!matchedPrevious && !select.value && select.options.length > 0) {
    select.options[0].selected = true;
  }
}

function updateStatus(status) {
  currentStatus = status;

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const monitorBtn = document.getElementById('monitor-toggle-btn');
  const monitorBtnText = document.getElementById('monitor-btn-text');
  const recordBtn = document.getElementById('record-btn');
  const recordBtnText = document.getElementById('record-btn-text');
  const recordIndicator = document.getElementById('recording-indicator');
  const recordStateLabel = document.getElementById('recording-state-label');
  const timerDisplay = document.getElementById('timer-display');

  if (status.monitoring) {
    monitorBtn.classList.add('active');
    monitorBtnText.textContent = 'Monitoring Active (M)';
  } else {
    monitorBtn.classList.remove('active');
    monitorBtnText.textContent = 'Enable Monitor (M)';
    updateVUMeters(0, 0);
    amplitudeHistory.fill(0);
    spectrumPeaks.fill(0);
    renderAnalyzerFrame(0, 0, latestSpectrum, false);
  }

  // Sync device select if backend has an active device
  const activeDevice = status.recordingDevice || status.monitoringDevice;
  const deviceSelect = document.getElementById('device-select');
  if (activeDevice && deviceSelect && Array.from(deviceSelect.options).some(o => o.value === activeDevice)) {
    deviceSelect.value = activeDevice;
  }

  if (status.recording) {
    if (status.recordingState === 'armed') {
      recordBtn.disabled = false;
      recordBtn.className = 'btn btn-record armed';
      recordBtnText.textContent = 'Armed: Waiting for Sound... (Space to Cancel)';
      recordIndicator.className = 'recording-indicator-pulse armed';
      if (recordStateLabel) recordStateLabel.textContent = 'ARMED';
      timerDisplay.className = 'timer-display armed';
      statusDot.className = 'status-dot armed';
      statusText.textContent = 'ARMED';
    } else if (status.recordingState === 'finalizing') {
      recordBtn.className = 'btn btn-record recording';
      recordBtn.disabled = true;
      recordBtnText.textContent = 'Finalizing WAV...';
      recordIndicator.className = 'recording-indicator-pulse';
      if (recordStateLabel) recordStateLabel.textContent = 'FINALIZING';
      timerDisplay.className = 'timer-display recording';
      statusDot.className = 'status-dot recording';
      statusText.textContent = 'FINALIZING';
    } else {
      recordBtn.disabled = false;
      recordBtn.className = 'btn btn-record recording';
      recordBtnText.textContent = 'Stop Recording (Space)';
      recordIndicator.className = 'recording-indicator-pulse active';
      if (recordStateLabel) recordStateLabel.textContent = 'RECORDING';
      timerDisplay.className = 'timer-display recording';
      statusDot.className = 'status-dot recording';
      statusText.textContent = 'RECORDING';
    }
  } else {
    recordBtn.disabled = !ws || ws.readyState !== WebSocket.OPEN;
    recordBtn.className = 'btn btn-record';
    recordBtnText.textContent = 'Start Recording (Space)';
    recordIndicator.className = 'recording-indicator-pulse';
    if (recordStateLabel) recordStateLabel.textContent = 'STANDBY';
    timerDisplay.className = 'timer-display idle';
    timerDisplay.textContent = '00:00:00';
    document.getElementById('record-size').textContent = '0.00 MB';

    if (ws && ws.readyState === WebSocket.OPEN) {
      if (status.monitoring) {
        statusDot.className = 'status-dot monitoring';
        statusText.textContent = 'MONITORING';
      } else {
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'CONNECTED';
      }
    }
  }
}

function syncActiveTrackMetadata() {
  if (!activeTrack) return;
  const updated = allRecordings.find(r => r.filename === activeTrack.filename);
  if (updated) {
    activeTrack = updated;
    document.getElementById('player-title').textContent = updated.title || updated.filename;
    document.getElementById('player-artist').textContent = updated.artist || 'Unknown Artist';
    document.getElementById('player-filename').textContent = updated.filename;
  }
}

// Render Library with Search & Filter Pills
function renderRecordingsList() {
  const list = document.getElementById('recordings-list');
  const query = (document.getElementById('library-search').value || '').trim().toLowerCase();

  const filtered = allRecordings.filter(rec => {
    if (activeFilter === 'favorites' && !rec.favorite) return false;
    if (activeFilter === 'eligible' && !rec.publishEligible) return false;
    if (!query) return true;
    const matchName = rec.filename.toLowerCase().includes(query);
    const matchTitle = (rec.title || '').toLowerCase().includes(query);
    const matchArtist = (rec.artist || '').toLowerCase().includes(query);
    const matchNotes = (rec.notes || '').toLowerCase().includes(query);
    const matchTags = (rec.tags || []).some(t => t.toLowerCase().includes(query));
    return matchName || matchTitle || matchArtist || matchNotes || matchTags;
  });

  const countBadge = document.getElementById('library-count-badge');
  if (countBadge) {
    countBadge.textContent = `${filtered.length} ${filtered.length === 1 ? 'track' : 'tracks'}`;
  }

  if (filtered.length === 0) {
    const emptyMessage = query
      ? 'No matching recordings found'
      : (activeFilter === 'favorites'
        ? 'No favorite tracks yet'
        : (activeFilter === 'eligible' ? 'No Break-Wave eligible tracks yet' : 'No recordings in vault'));
    const emptySub = query
      ? 'Try a different search keyword or clear active filters.'
      : (activeFilter === 'favorites'
        ? 'Star any recording in the vault to pin it here.'
        : 'Owned-input recordings you capture will appear here.');

    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
          </svg>
        </div>
        <p class="empty-title">${emptyMessage}</p>
        <p class="empty-subtext">${emptySub}</p>
      </div>
    `;
    return;
  }

  list.innerHTML = '';
  filtered.forEach(rec => {
    const isPlayingThis = activeTrack && activeTrack.filename === rec.filename;
    const item = document.createElement('div');
    item.className = `recording-item ${isPlayingThis ? 'active' : ''}`;

    const dateStr = new Date(rec.createdAt).toLocaleDateString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const durationPill = typeof rec.durationSeconds === 'number' && rec.durationSeconds > 0
      ? `<span class="rec-duration">${formatTrackTime(rec.durationSeconds)}</span><span class="rec-divider">•</span>`
      : '';

    const sourceBadge = rec.publishEligible
      ? '<span class="source-badge owned" title="Captured from a dedicated owned audio input">OWNED INPUT</span>'
      : '';

    const tagsHtml = (rec.tags || []).map(t => `<span class="track-tag">${escapeHtml(t)}</span>`).join('');

    let publishTitle = 'Copy to configured Auto-KJ Break-Wave folder';
    if (!rec.publishEligible) {
      publishTitle = 'Only owned-input recordings can be published';
    } else if (!integrationStatus.breakWavePublishConfigured) {
      publishTitle = 'Set BREAK_WAVE_PUBLISH_DIR on the server to enable Auto-KJ Break-Wave handoff';
    }

    item.innerHTML = `
      <div class="rec-icon-col">
        <button class="btn-item-play" type="button" title="${isPlayingThis ? 'Replay / Select Track' : 'Play Track'}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
      <div class="rec-info-col">
        <div class="rec-title-row">
          <span class="rec-title">${escapeHtml(rec.title || rec.filename)}</span>
          ${rec.favorite ? '<span class="rec-star" title="Favorite">★</span>' : ''}
          ${sourceBadge}
        </div>
        <div class="rec-meta-row">
          <span class="rec-artist">${escapeHtml(rec.artist || 'Unknown Artist')}</span>
          <span class="rec-divider">•</span>
          ${durationPill}
          <span class="rec-size">${formatBytes(rec.sizeBytes)}</span>
          <span class="rec-divider">•</span>
          <span class="rec-date">${dateStr}</span>
        </div>
        ${tagsHtml ? `<div class="rec-tags-row">${tagsHtml}</div>` : ''}
      </div>
      <div class="rec-actions-col">
        <button class="btn-rec-action favorite-btn ${rec.favorite ? 'active' : ''}" type="button" title="${rec.favorite ? 'Remove from Favorites' : 'Mark as Favorite'}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
        </button>
        <button class="btn-rec-action edit-meta-btn" type="button" title="Edit Metadata &amp; Tags">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="btn-rec-action export-btn" type="button" title="Export / Transcode">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </button>
        <button class="btn-rec-action publish-btn" type="button" title="${publishTitle}" ${(!rec.publishEligible || !integrationStatus.breakWavePublishConfigured) ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>
        </button>
        <button class="btn-rec-action delete-btn" type="button" title="Delete Recording">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    `;

    item.querySelector('.btn-item-play').addEventListener('click', (e) => {
      e.stopPropagation();
      playTrack(rec);
    });
    item.addEventListener('click', () => playTrack(rec));

    item.querySelector('.favorite-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleFavorite(rec);
    });

    item.querySelector('.edit-meta-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openMetadataModal(rec);
    });

    item.querySelector('.export-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openExportModal(rec);
    });

    item.querySelector('.publish-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!e.currentTarget.disabled) await publishRecording(rec);
    });

    item.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteModal(rec);
    });

    list.appendChild(item);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

async function toggleFavorite(rec) {
  try {
    const res = await fetch(`/api/recordings/${encodeURIComponent(rec.filename)}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: !rec.favorite })
    });
    if (!res.ok) throw new Error('Failed to update favorite status');
    rec.favorite = !rec.favorite;
    renderRecordingsList();
  } catch (err) {
    showMessage(err.message || 'Unable to update favorite state', true);
  }
}

// Filter Chips
document.querySelectorAll('.filter-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter || 'all';
    renderRecordingsList();
  });
});

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
  document.getElementById('player-artist').textContent = rec.artist || 'Unknown Artist';
  document.getElementById('player-filename').textContent = rec.filename;

  playerProgress.value = 0;
  playerTimeCurrent.textContent = '00:00';
  playerTimeDuration.textContent = typeof rec.durationSeconds === 'number'
    ? formatTrackTime(rec.durationSeconds)
    : '00:00';

  audio.src = `/recordings/${encodeURIComponent(rec.filename)}`;
  audio.playbackRate = parseFloat(playerSpeed.value) || 1.0;
  audio.volume = (parseFloat(playerVolume.value) || 80) / 100;
  audio.play().catch(() => {});
  playIcon.classList.add('hidden');
  pauseIcon.classList.remove('hidden');
  renderRecordingsList();
}

document.getElementById('player-close-btn').addEventListener('click', () => {
  audio.pause();
  audio.removeAttribute('src');
  playerPanel.classList.add('hidden');
  activeTrack = null;
  renderRecordingsList();
});

playerPlayBtn.addEventListener('click', () => {
  if (!activeTrack) return;
  if (audio.paused) {
    audio.play().catch(() => {});
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

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration)) {
    playerTimeDuration.textContent = formatTrackTime(audio.duration);
  }
});

audio.addEventListener('timeupdate', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    const progress = (audio.currentTime / audio.duration) * 100;
    playerProgress.value = progress;
    playerTimeCurrent.textContent = formatTrackTime(audio.currentTime);
    playerTimeDuration.textContent = formatTrackTime(audio.duration);
  }
});

playerProgress.addEventListener('input', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
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

// Export Modal & Smart Bitrate State
function syncExportBitrateAvailability() {
  const checked = document.querySelector('input[name="export-format"]:checked');
  const format = checked ? checked.value : 'mp3';
  const isLossless = format === 'flac' || format === 'wav';
  const bitrateSelect = document.getElementById('export-bitrate');
  const losslessHint = document.getElementById('bitrate-lossless-hint');
  if (bitrateSelect) bitrateSelect.disabled = isLossless;
  if (losslessHint) losslessHint.classList.toggle('hidden', !isLossless);
}

document.querySelectorAll('input[name="export-format"]').forEach(radio => {
  radio.addEventListener('change', syncExportBitrateAvailability);
});

function openExportModal(rec) {
  activeExportFilename = rec.filename;
  document.getElementById('export-target-filename').textContent = rec.title || rec.filename;
  syncExportBitrateAvailability();
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
  showMessage(`Started ${format.toUpperCase()} export for ${activeExportFilename}`);
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
  document.getElementById('meta-favorite').checked = Boolean(rec.favorite);
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
  const favorite = document.getElementById('meta-favorite').checked;

  const tags = rawTags.split(',').map(t => t.trim()).filter(Boolean);

  try {
    const res = await fetch(`/api/recordings/${encodeURIComponent(filename)}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, artist, tags, notes, favorite })
    });
    if (!res.ok) throw new Error('Failed to save metadata');
    document.getElementById('metadata-modal').classList.add('hidden');
    showMessage(`Updated metadata for ${title || filename}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ command: 'refresh_recordings' }));
    }
  } catch (err) {
    showMessage(err.message || 'Failed to save metadata', true);
  }
});

// Delete Confirmation Modal & Handler
const deleteModal = document.getElementById('delete-modal');

function openDeleteModal(rec) {
  pendingDeleteRecording = rec;
  document.getElementById('delete-target-name').textContent = rec.title || rec.filename;
  deleteModal.classList.remove('hidden');
}

function closeDeleteModal() {
  pendingDeleteRecording = null;
  deleteModal.classList.add('hidden');
}

document.getElementById('delete-modal-close').addEventListener('click', closeDeleteModal);
document.getElementById('delete-cancel-btn').addEventListener('click', closeDeleteModal);
document.getElementById('delete-confirm-btn').addEventListener('click', async () => {
  if (!pendingDeleteRecording) return;
  const target = pendingDeleteRecording;
  closeDeleteModal();
  await deleteRecording(target.filename);
});

async function deleteRecording(filename) {
  try {
    const res = await fetch(`/api/recordings/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    if (res.ok) {
      if (activeTrack && activeTrack.filename === filename) {
        audio.pause();
        audio.removeAttribute('src');
        playerPanel.classList.add('hidden');
        activeTrack = null;
      }
      showMessage(`Deleted recording: ${filename}`);
    } else {
      throw new Error('Could not delete recording');
    }
  } catch (err) {
    showMessage(err.message || 'Error deleting recording', true);
  }
}

async function publishRecording(recording) {
  try {
    const response = await fetch(`/api/recordings/${encodeURIComponent(recording.filename)}/publish`, {
      method: 'POST'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || 'Break-Wave publish failed');
    }
    showMessage(`Copied to Auto-KJ Break-Wave as ${result.filename}. The WaveSentry source was preserved.`);
  } catch (error) {
    showMessage(error.message || 'Break-Wave publish failed', true);
  }
}

// Visualizer Mode Toggles
document.getElementById('viz-mode-wave').addEventListener('click', () => {
  vizMode = 'wave';
  document.getElementById('viz-mode-wave').classList.add('active');
  document.getElementById('viz-mode-fft').classList.remove('active');
  renderAnalyzerFrame(latestPeakL, latestPeakR, latestSpectrum, false);
});

document.getElementById('viz-mode-fft').addEventListener('click', () => {
  vizMode = 'fft';
  document.getElementById('viz-mode-fft').classList.add('active');
  document.getElementById('viz-mode-wave').classList.remove('active');
  renderAnalyzerFrame(latestPeakL, latestPeakR, latestSpectrum, false);
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

// Library search & refresh
document.getElementById('library-search').addEventListener('input', renderRecordingsList);
document.getElementById('refresh-library-btn').addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ command: 'refresh_recordings' }));
  }
});

// Rescan Audio Devices
document.getElementById('refresh-devices-btn').addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ command: 'get_devices' }));
    showMessage('Rescanned physical audio input devices');
  }
});

// Monitor & Record actions
const monitorToggleBtn = document.getElementById('monitor-toggle-btn');
monitorToggleBtn.addEventListener('click', () => {
  const deviceSelect = document.getElementById('device-select');
  const selectedDevice = deviceSelect.value;
  if (!selectedDevice || !ws || ws.readyState !== WebSocket.OPEN) return;

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
  if (!selectedDevice || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (currentStatus.recording) {
    ws.send(JSON.stringify({ command: 'stop_recording' }));
  } else {
    const artist = document.getElementById('recording-artist').value || 'Unknown Artist';
    const title = document.getElementById('recording-title').value || 'Owned Recording';
    const autoSplit = autoSplitToggle.checked;
    const thresh = thresholdSlider.value;
    const dur = durationSlider.value * 1000;

    ws.send(JSON.stringify({
      command: 'start_recording',
      params: {
        device: selectedDevice,
        artist: artist,
        title: title,
        autoSplitEnabled: autoSplit,
        silenceThresholdDb: thresh,
        silenceDurationMs: dur
      }
    }));
  }
}

// Shortcuts modal & Backdrop close
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

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      backdrop.classList.add('hidden');
    }
  });
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
  } else if (e.key.toLowerCase() === 'f') {
    if (activeTrack) {
      e.preventDefault();
      void toggleFavorite(activeTrack);
    }
  } else if (e.key === '/') {
    e.preventDefault();
    document.getElementById('library-search').focus();
  } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
    e.preventDefault();
    shortcutsModal.classList.toggle('hidden');
  } else if (e.key === 'Escape') {
    document.getElementById('export-modal').classList.add('hidden');
    document.getElementById('metadata-modal').classList.add('hidden');
    deleteModal.classList.add('hidden');
    shortcutsModal.classList.add('hidden');
  }
});

connectWebSocket();
