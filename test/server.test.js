const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isValidFilename,
  getRecordingMetadata,
  updateRecordingMetadata,
  computeSpectrum,
  listDevices,
  parsePipeWireInputDevices,
  parseWindowsAudioInputDevices,
  getRecordingsList,
  RECORDINGS_DIR
} = require('../src/server.js');

describe('WaveSentry Pro Backend Suite', () => {
  const testFilename = 'test_sample_recording.wav';
  const testFilePath = path.join(RECORDINGS_DIR, testFilename);

  before(() => {
    fs.writeFileSync(testFilePath, Buffer.alloc(1024, 0));
  });

  after(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  describe('Security: isValidFilename', () => {
    it('should allow valid clean filenames', () => {
      assert.equal(isValidFilename('recording_2026-08-25.wav'), true);
      assert.equal(isValidFilename('sample-audio.mp3'), true);
      assert.equal(isValidFilename('My Recording 01.flac'), true);
      assert.equal(isValidFilename('Artist - Wait... What [abc123].wav'), true);
    });

    it('should reject directory traversal attacks', () => {
      assert.equal(isValidFilename('../../../etc/passwd'), false);
      assert.equal(isValidFilename('..\\windows\\system32'), false);
      assert.equal(isValidFilename('/var/log/syslog'), false);
      assert.equal(isValidFilename('sub/dir/file.wav'), false);
      assert.equal(isValidFilename(''), false);
      assert.equal(isValidFilename(null), false);
    });
  });

  describe('Metadata Management', () => {
    it('should retrieve default metadata for new file', () => {
      const meta = getRecordingMetadata('brand_new_track.wav');
      assert.equal(meta.title, 'brand new track');
      assert.equal(meta.artist, 'Unknown Artist');
      assert.equal(meta.sourceKind, 'unknown');
      assert.deepEqual(meta.tags, []);
    });

    it('should update and persist track metadata', () => {
      const updated = updateRecordingMetadata(testFilename, {
        title: 'Studio Session 101',
        artist: 'Antigravity Band',
        tags: ['live', 'rehearsal'],
        notes: 'Recorded in 44.1kHz stereo'
      });

      assert.equal(updated.title, 'Studio Session 101');
      assert.equal(updated.artist, 'Antigravity Band');
      assert.deepEqual(updated.tags, ['live', 'rehearsal']);

      const retrieved = getRecordingMetadata(testFilename);
      assert.equal(retrieved.title, 'Studio Session 101');
    });
  });

  describe('Spectral Audio Processing', () => {
    it('should compute 16-band spectrum from PCM audio chunk', () => {
      const dummyPcm = Buffer.alloc(2048);
      for (let i = 0; i < 2048; i += 4) {
        dummyPcm.writeInt16LE(15000, i);
        dummyPcm.writeInt16LE(15000, i + 2);
      }

      const spectrum = computeSpectrum(dummyPcm, 4);
      assert.equal(Array.isArray(spectrum), true);
      assert.equal(spectrum.length, 16);
      spectrum.forEach(val => {
        assert.ok(val >= 0 && val <= 1.0, `Band value ${val} should be between 0 and 1`);
      });
    });
  });

  describe('Recordings & Device Enumeration', () => {
    it('should list recordings with enriched metadata', () => {
      const list = getRecordingsList();
      assert.ok(Array.isArray(list));
      const found = list.find(r => r.filename === testFilename);
      assert.ok(found, 'Test recording should be listed');
      assert.equal(found.title, 'Studio Session 101');
    });

    it('should list available audio devices gracefully', () => {
      const devices = listDevices();
      assert.ok(Array.isArray(devices));
      devices.forEach(device => {
        assert.ok(device.name);
        assert.equal(device.type, 'input');
        assert.equal(device.captureMode, 'owned_input');
      });
    });

    it('should include physical PipeWire sources and exclude sink monitors', () => {
      const devices = parsePipeWireInputDevices([
        { info: { props: { 'media.class': 'Audio/Source', 'node.name': 'alsa_input.usb-mixer', 'node.description': 'USB Mixer' } } },
        { info: { props: { 'media.class': 'Audio/Source', 'node.name': 'alsa_output.pci.monitor', 'node.description': 'Monitor of Speakers' } } },
        { info: { props: { 'media.class': 'Audio/Sink', 'node.name': 'alsa_output.pci', 'node.description': 'Speakers' } } }
      ], 'alsa_input.usb-mixer');
      assert.deepEqual(devices.map(device => device.id), ['alsa_input.usb-mixer']);
      assert.equal(devices[0].isDefault, true);
    });

    it('should include DirectShow inputs and exclude known system-loopback devices', () => {
      const output = [
        '[dshow] DirectShow audio devices',
        '[dshow]  "Microphone (USB Mixer)"',
        '[dshow]  "Stereo Mix (Realtek)"',
        '[dshow]  "virtual-audio-capturer"'
      ].join('\n');
      const devices = parseWindowsAudioInputDevices(output);
      assert.deepEqual(devices.map(device => device.id), ['Microphone (USB Mixer)']);
    });
  });
});
