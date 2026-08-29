# WaveSentry Pro

**Owned-input recorder, analyzer, transcoder, and safe Auto-KJ Break-Wave handoff**

WaveSentry records a dedicated microphone, line input, mixer, or USB audio interface on **Linux** (PipeWire) and **Windows** (DirectShow/FFmpeg). It can copy a finalized owned-input WAV into a server-configured Auto-KJ Break-Wave library without deleting the WaveSentry source.

WaveSentry is not a streaming-service recorder. It does not enumerate output sinks, expose `virtual-audio-capturer`, use PipeWire sink monitors, or support Spotify/DRM capture or ripping. Import purchased audio files directly into Auto-KJ whenever possible.

---

## ✨ Features

*   **Dedicated-input capture**:
    *   **Linux (PipeWire)**: enumerates `Audio/Source` nodes and records them with `pw-record`.
    *   **Windows (DirectShow)**: enumerates physical/audio-interface inputs and records them with FFmpeg.
*   **Crash-safe recording finalization**:
    *   Records into a private staging directory, waits for the recorder child process to close, validates the held nonempty WAV, then publishes it with an atomic no-clobber hard link. A staging entry is removed only while it still identifies the file WaveSentry opened; otherwise it is left for recovery.
    *   Uses collision-safe `Artist - Title [short-id].wav` filenames and persists provenance in `.metadata.json`.
*   **Auto-KJ Break-Wave handoff**:
    *   Copies eligible owned-input WAVs into `BREAK_WAVE_PUBLISH_DIR` and writes an adjacent JSON sidecar.
    *   The source recording is preserved. A request can never choose the destination directory.
*   **Dual-Mode Real-Time Visualizer**:
    *   **Oscilloscope Waveform**: Glowing cyber amplitude waveform history.
    *   **16-Band Spectral FFT Analyzer**: Real-time frequency equalizer bars with peak hold decay and clipping indicators.
*   **Studio Precision VU Metering**:
    *   Stereo Left & Right level meters with peak hold indicators, continuous numerical `-dBFS` readouts, and active `CLIP` overload warnings.
*   **Multi-Format Transcoder Engine**:
    *   Instant on-the-fly export to **MP3** (up to 320kbps), **FLAC** (lossless), **AAC / M4A**, **OGG Vorbis**, and original **WAV**.
*   **Track Metadata Studio**:
    *   In-app metadata editor for track title, artist, custom tags, and session notes stored in `.metadata.json` and embedded when using the separate export/transcode endpoint.
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
| `/api/recordings` | GET | List recorded files enriched with metadata |
| `/api/integration` | GET | Report whether configured Break-Wave publishing is available |
| `/api/recordings/:filename` | DELETE | Delete recording and metadata |
| `/api/recordings/:filename/metadata` | GET / POST | Get or update track title, artist, tags, and notes |
| `/api/recordings/:filename/publish` | POST | Copy an eligible owned-input WAV to the configured Break-Wave directory |
| `/api/recordings/:filename/export` | GET | Transcode and stream audio (`?format=mp3&bitrate=320k`) |
| `/` | WS | Real-time level telemetry, spectrum FFT, status, and recording progress |

---

## 📄 License

MIT License.
