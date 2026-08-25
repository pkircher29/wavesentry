# WaveSentry Pro 🌊🎧

**High-Performance Audio Output Monitor, Recorder, Spectral Analyzer & Transcoder**

WaveSentry is a desktop audio workstation designed to monitor, capture, analyze, tag, and transcode system audio loopback channels on both **Linux** (PipeWire / PulseAudio) and **Windows** (DirectShow / WASAPI loopback).

---

## ✨ Features

*   **Native Cross-Platform Audio Capture**:
    *   **Linux (PipeWire)**: Interacts natively with `pw-record` and `pw-dump` to capture mixed output from audio sinks (speakers, headphones, virtual streams).
    *   **Windows (DirectShow / WASAPI)**: Audio loopback capture via background `ffmpeg` engine.
*   **Dual-Mode Real-Time Visualizer**:
    *   **Oscilloscope Waveform**: Glowing cyber amplitude waveform history.
    *   **16-Band Spectral FFT Analyzer**: Real-time frequency equalizer bars with peak hold decay and clipping indicators.
*   **Studio Precision VU Metering**:
    *   Stereo Left & Right level meters with peak hold indicators, continuous numerical `-dBFS` readouts, and active `CLIP` overload warnings.
*   **Multi-Format Transcoder Engine**:
    *   Instant on-the-fly export to **MP3** (up to 320kbps), **FLAC** (lossless), **AAC / M4A**, **OGG Vorbis**, and original **WAV**.
*   **Track Metadata Studio**:
    *   In-app metadata editor for track title, artist, custom tags, and session notes stored in `.metadata.json` and embedded in audio export ID3 tags.
*   **Smart Auto-Split on Silence**:
    *   Continuous hands-free recording with automatic segment splitting based on customizable dB threshold (-60dB to -25dB) and silence duration (0.5s to 5.0s).
*   **Integrated Vault Audio Player**:
    *   Built-in playback scrubber, speed adjustments (`0.5x`, `0.75x`, `1.0x`, `1.25x`, `1.5x`, `2.0x`), +/- 5s skip buttons, volume slider, and instant search filter.
*   **Keyboard Shortcuts**:
    *   `Space` / `Ctrl+R`: Start/Stop Recording
    *   `M`: Toggle Live VU Monitoring
    *   `V`: Toggle Visualizer Mode (Waveform / Spectrum FFT)
    *   `P`: Play/Pause Selected Track
    *   `Esc`: Close Modals
    *   `?`: Open Shortcuts Cheat Sheet

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| <kbd>Space</kbd> / <kbd>Ctrl+R</kbd> | Toggle Recording Start / Stop |
| <kbd>M</kbd> | Toggle Audio Monitoring |
| <kbd>V</kbd> | Switch Visualizer Mode (Waveform &harr; FFT Spectrum) |
| <kbd>P</kbd> | Play / Pause Selected Vault Track |
| <kbd>Esc</kbd> | Dismiss Active Modal |
| <kbd>?</kbd> | Open Shortcuts Reference |

---

## 🚀 Quick Start

### Prerequisites
*   **Node.js** 18+ (tested on Node 18, 20, 22)
*   **FFmpeg** installed on your system PATH (used for WASAPI/DirectShow recording on Windows and on-the-fly multi-format transcoding)
*   **PipeWire** (`pw-record`, `pw-dump`, `wpctl`) for Linux

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/pkircher29/wavesentry.git
cd wavesentry

# Install dependencies
npm install

# Run the web dashboard
npm start

# Run the Electron desktop app
npm run electron
```

Open your browser at `http://localhost:3000`.

---

## 🧪 Testing

WaveSentry includes a test suite using Node.js native test runner:

```bash
npm test
```

---

## 📡 REST API & WebSocket

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/devices` | GET | List available audio sinks and default device |
| `/api/recordings` | GET | List recorded files enriched with metadata |
| `/api/recordings/:filename` | DELETE | Delete recording and metadata |
| `/api/recordings/:filename/metadata` | GET / POST | Get or update track title, artist, tags, and notes |
| `/api/recordings/:filename/export` | GET | Transcode and stream audio (`?format=mp3&bitrate=320k`) |
| `/` | WS | Real-time level telemetry, spectrum FFT, status, and recording progress |

---

## 📄 License

MIT License.
