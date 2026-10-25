# WaveSentry Pro

**Owned-input recorder, analyzer, transcoder, and safe Auto-KJ Break-Wave handoff**

WaveSentry records a dedicated microphone, line input, mixer, or USB audio interface on **Linux** (PipeWire) and **Windows** (DirectShow/FFmpeg). It can copy a finalized owned-input WAV into a server-configured Auto-KJ Break-Wave library without deleting the WaveSentry source.

System audio (what your speakers play) can also be recorded: pick a "System audio:" entry in the device list (PipeWire sink monitors on Linux; Stereo Mix / virtual-audio-capturer on Windows). Those takes are tagged `system_loopback` and are never eligible for the Auto-KJ Break-Wave handoff. Only record audio you have the right to record.

---

## ✨ Features

*   **Dedicated-input capture**:
    *   **Linux (PipeWire)**: enumerates `Audio/Source` nodes and records them with `pw-record`.
    *   **Windows (DirectShow)**: enumerates physical/audio-interface inputs and records them with FFmpeg.
    *   **Live Input Rescan**: rescan connected audio interfaces on the fly without restarting the server.
*   **Crash-safe recording finalization**:
    *   Records into a private staging directory, waits for the recorder child process to close, validates the held nonempty WAV, then publishes it with an atomic no-clobber hard link. A staging entry is removed only while it still identifies the file WaveSentry opened; otherwise it is left for recovery.
    *   Uses collision-safe `Artist - Title [short-id].wav` filenames and persists provenance and duration in `.metadata.json`.
*   **Auto-KJ Break-Wave handoff**:
    *   Copies eligible owned-input WAVs into `BREAK_WAVE_PUBLISH_DIR` and writes an adjacent JSON sidecar.
    *   The source recording is preserved. A request can never choose the destination directory.
*   **Dual-Mode Real-Time Signal Analyzer**:
    *   **Oscilloscope Waveform**: Precision studio graticule with real-time stereo amplitude history.
    *   **16-Band Spectral FFT Analyzer**: Real-time frequency band bars (`32 Hz` – `16 kHz`) with peak hold decay.
*   **Studio Precision VU Metering**:
    *   Stereo Left & Right level meters with calibrated dB scale markings, peak hold indicators, continuous numerical `-dBFS` readouts (`tabular-nums`), and click-to-reset `CLIP` overload indicators.
*   **Multi-Format Transcoder Engine**:
    *   Instant on-the-fly export to **MP3** (up to 320kbps), **FLAC** (lossless), **AAC / M4A**, **OGG Vorbis**, and **WAV** (16-bit PCM), automatically locking bitrate selection when a lossless format is chosen.
*   **Track Metadata Studio & Vault Filtering**:
    *   In-app metadata editor for track title, artist, custom tags, session notes, and favorite status (`★`) stored in `.metadata.json` and embedded when using the export/transcode endpoint.
    *   One-click vault filter chips (**All Tracks**, **Favorites ★**, **Break-Wave Eligible**) plus instant keyword/tag search.
*   **Smart Auto-Split on Silence**:
    *   Continuous hands-free recording with automatic segment splitting based on customizable dB threshold (`-60 dB` to `-25 dB`) and silence duration (`0.5 s` to `5.0 s`), using non-blocking studio toast notifications so automated sessions are never interrupted by modal browser alerts.
*   **Integrated Vault Audio Player**:
    *   Built-in playback scrubber, speed adjustments (`0.5x`, `0.75x`, `1.0x`, `1.25x`, `1.5x`, `2.0x`), `-5s` / `+5s` transport skip controls, volume slider, and direct export trigger.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| <kbd>Space</kbd> / <kbd>Ctrl+R</kbd> | Toggle Recording Start / Stop |
| <kbd>M</kbd> | Toggle Audio Monitoring |
| <kbd>V</kbd> | Switch Visualizer Mode (Waveform &harr; FFT Spectrum) |
| <kbd>P</kbd> | Play / Pause Selected Vault Track |
| <kbd>F</kbd> | Toggle Favorite on Selected Vault Track |
| <kbd>/</kbd> | Focus Vault Search Input |
| <kbd>Esc</kbd> | Dismiss Active Modal or Blur Input |
| <kbd>?</kbd> | Open Shortcuts Reference |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>~</kbd> | Toggle Debug Log (server + auto-split diagnostics) |

---

## 🚀 Quick Start

### Prerequisites
*   **Node.js** 22.12+ (CI tests Node 22 and 24)
*   **FFmpeg** installed on your system PATH (used for DirectShow input recording on Windows and on-the-fly multi-format export)
*   **PipeWire** (`pw-record`, `pw-dump`, `wpctl`) for Linux

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/pkircher29/wavesentry.git
cd wavesentry

# Install exactly the reviewed dependency lock
npm ci

# Run the web dashboard
npm start

# Run the Electron desktop app
npm run electron
```

Open your browser at `http://127.0.0.1:3000`. The server and its port probe bind only to IPv4 loopback. Browser API and WebSocket requests are accepted only from the exact `127.0.0.1` or `localhost` origin on the active port.

### Auto-KJ Break-Wave publish configuration

Set `BREAK_WAVE_PUBLISH_DIR` to the same dedicated break-track library directory configured in Auto-KJ before starting WaveSentry:

```bash
BREAK_WAVE_PUBLISH_DIR='C:/Users/Paul/Music/Auto-KJ-Break-Wave' npm start
```

The directory is process configuration, not an API argument. The Publish button stays disabled when it is unset or when a recording was not created by WaveSentry's owned-input mode. Auto-KJ can discover the copied WAV through its normal Break-Wave library rescan/fingerprint path and the host remains responsible for queueing it.

Published WAVs retain the correct metadata-derived filename and an adjacent `.wav.json` sidecar. WaveSentry does not currently rewrite embedded tags in the stored or published WAV; embedded metadata is available only through the separate export/transcode flow.

WaveSentry holds and identity-checks the source file while copying it. Final audio and sidecar names are reserved without overwriting existing entries. If metadata or sidecar persistence fails after a public audio name has been created, WaveSentry reports a recovery error and leaves that public audio in place rather than risking deletion of a concurrently replaced file.

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
| `/api/devices` | GET | List eligible dedicated audio inputs |
| `/api/recordings` | GET | List recorded files enriched with metadata and duration |
| `/api/integration` | GET | Report whether configured Break-Wave publishing is available |
| `/api/recordings/:filename` | DELETE | Delete recording and metadata |
| `/api/recordings/:filename/metadata` | GET / POST | Get or update track title, artist, tags, notes, and favorite state |
| `/api/recordings/:filename/publish` | POST | Copy an eligible owned-input WAV to the configured Break-Wave directory |
| `/api/recordings/:filename/export` | GET | Transcode and stream audio (`?format=mp3&bitrate=320k`) |
| `/` | WS | Real-time level telemetry, spectrum FFT, status, device rescan, and recording progress |

---

## 📄 License

MIT License.
