const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  assertSimpleWavFilename,
  buildCaptureProcessSpec,
  createTrackFilename,
  finalizeOwnedRecording,
  isDedicatedInputDevice,
  publishOwnedRecording,
  validateWavFile,
  waitForChildClose
} = require('../src/owned-audio.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wavesentry-owned-audio-'));
}

function makeWavPayload(audioBytes = 256) {
  const payload = Buffer.alloc(44 + audioBytes);
  payload.write('RIFF', 0, 'ascii');
  payload.writeUInt32LE(payload.length - 8, 4);
  payload.write('WAVE', 8, 'ascii');
  payload.write('fmt ', 12, 'ascii');
  payload.writeUInt32LE(16, 16);
  payload.writeUInt16LE(1, 20);
  payload.writeUInt16LE(2, 22);
  payload.writeUInt32LE(44100, 24);
  payload.writeUInt32LE(176400, 28);
  payload.writeUInt16LE(4, 32);
  payload.writeUInt16LE(16, 34);
  payload.write('data', 36, 'ascii');
  payload.writeUInt32LE(audioBytes, 40);
  return payload;
}

describe('owned-source capture boundary', () => {
  it('waits for child close, not merely exit, before allowing finalization', async () => {
    const child = new EventEmitter();
    let settled = false;
    const completion = waitForChildClose(child).then(result => {
      settled = true;
      return result;
    });

    child.emit('exit', 0, null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);

    child.emit('close', 0, null);
    assert.deepEqual(await completion, { code: 0, signal: null, spawnError: null });
  });

  it('accepts dedicated inputs and rejects known loopback/system-capture devices', () => {
    assert.equal(isDedicatedInputDevice('Microphone (USB Audio Interface)'), true);
    assert.equal(isDedicatedInputDevice('alsa_input.usb-Focusrite_Scarlett'), true);
    assert.equal(isDedicatedInputDevice('virtual-audio-capturer'), false);
    assert.equal(isDedicatedInputDevice('alsa_output.pci.stereo.monitor'), false);
    assert.equal(isDedicatedInputDevice('Stereo Mix (Realtek Audio)'), false);
    assert.equal(isDedicatedInputDevice('VB-Audio CABLE Output'), false);
  });

  it('builds Windows and Linux input capture commands without loopback flags', () => {
    const windowsSpec = buildCaptureProcessSpec({
      platform: 'win32',
      device: 'Microphone (USB Audio Interface)',
      outputPath: 'C:\\capture\\take.wav',
      sampleRate: 44100
    });
    assert.equal(windowsSpec.command, 'ffmpeg');
    assert.deepEqual(windowsSpec.args.slice(0, 4), ['-hide_banner', '-loglevel', 'error', '-f']);
    assert.ok(windowsSpec.args.includes('audio=Microphone (USB Audio Interface)'));
    assert.ok(windowsSpec.args.includes('-f'));
    assert.ok(windowsSpec.args.includes('wav'));
    assert.ok(!windowsSpec.args.join(' ').includes('virtual-audio-capturer'));

    const linuxSpec = buildCaptureProcessSpec({
      platform: 'linux',
      device: 'alsa_input.usb-Focusrite_Scarlett',
      outputPath: '/tmp/take.wav',
      sampleRate: 44100
    });
    assert.equal(linuxSpec.command, 'pw-record');
    assert.deepEqual(linuxSpec.args.slice(0, 2), ['--target', 'alsa_input.usb-Focusrite_Scarlett']);
    assert.ok(!linuxSpec.args.join(' ').includes('stream.capture.sink'));

    assert.throws(() => buildCaptureProcessSpec({
      platform: 'win32',
      device: 'virtual-audio-capturer',
      outputPath: 'take.wav'
    }), /dedicated audio input/i);
  });

  it('creates sanitized metadata-aware Break-Wave filenames', () => {
    assert.equal(
      createTrackFilename({ artist: 'AC/DC', title: 'Owned: Take?', id: 'request-123456789' }),
      'AC DC - Owned Take [request-123].wav'
    );
  });

  it('accepts internal ellipses but structurally rejects traversal and separators', () => {
    assert.doesNotThrow(() => assertSimpleWavFilename('Artist - Wait... What [abc123].wav'));
    assert.throws(() => assertSimpleWavFilename('../outside.wav'), /invalid source filename/i);
    assert.throws(() => assertSimpleWavFilename('folder/track.wav'), /invalid source filename/i);
    assert.throws(() => assertSimpleWavFilename('folder\\track.wav'), /invalid source filename/i);
    assert.throws(() => assertSimpleWavFilename('..'), /invalid source filename/i);
  });

  it('validates a finalized WAV and atomically moves it out of staging', async () => {
    const recordingsDir = makeTempDir();
    const stagingDir = path.join(recordingsDir, '.staging');
    fs.mkdirSync(stagingDir);
    const tempPath = path.join(stagingDir, 'capture.wav');
    fs.writeFileSync(tempPath, makeWavPayload());
    const metadataUpdates = [];

    const result = await finalizeOwnedRecording({
      tempPath,
      recordingsDir,
      artist: 'The Example Band',
      title: 'First Take',
      id: 'abc12345',
      device: 'USB Line In',
      capturedAt: '2026-08-29T12:00:00.000Z',
      persistMetadata(filename, metadata) {
        metadataUpdates.push({ filename, metadata });
      }
    });

    assert.equal(result.filename, 'The Example Band - First Take [abc12345].wav');
    assert.equal(fs.existsSync(tempPath), false);
    assert.deepEqual(await validateWavFile(result.filePath), { sizeBytes: 300 });
    assert.equal(metadataUpdates.length, 1);
    assert.equal(metadataUpdates[0].metadata.sourceKind, 'owned_input');
    assert.equal(metadataUpdates[0].metadata.captureDevice, 'USB Line In');
    assert.equal(result.stagingCleanupPending, false);
  });

  it('never overwrites an existing finalized recording on an id collision', async () => {
    const recordingsDir = makeTempDir();
    const stagingDir = path.join(recordingsDir, '.staging');
    fs.mkdirSync(stagingDir);
    const originalName = 'Artist - Title [request-123].wav';
    fs.writeFileSync(path.join(recordingsDir, originalName), makeWavPayload(64));
    const tempPath = path.join(stagingDir, 'capture.wav');
    fs.writeFileSync(tempPath, makeWavPayload(128));

    const result = await finalizeOwnedRecording({
      tempPath,
      recordingsDir,
      artist: 'Artist',
      title: 'Title',
      id: 'request-123456789',
      persistMetadata() {}
    });

    assert.equal(result.filename, 'Artist - Title [request-1-2].wav');
    assert.equal(fs.statSync(path.join(recordingsDir, originalName)).size, 108);
  });

  it('retries finalization without overwriting a destination created after selection', async () => {
    const recordingsDir = makeTempDir();
    const stagingDir = path.join(recordingsDir, '.staging');
    fs.mkdirSync(stagingDir);
    const tempPath = path.join(stagingDir, 'capture.wav');
    const competingPayload = makeWavPayload(32);
    fs.writeFileSync(tempPath, makeWavPayload(192));
    let injectedRace = false;

    const result = await finalizeOwnedRecording({
      tempPath,
      recordingsDir,
      artist: 'Race Artist',
      title: 'Race Title',
      id: 'race-id',
      persistMetadata() {},
      async linkFile(sourcePath, destinationPath) {
        if (!injectedRace) {
          injectedRace = true;
          await fs.promises.writeFile(destinationPath, competingPayload, { flag: 'wx' });
          const error = new Error('simulated late collision');
          error.code = 'EEXIST';
          throw error;
        }
        return fs.promises.link(sourcePath, destinationPath);
      }
    });

    assert.equal(result.filename, 'Race Artist - Race Title [race-id-2].wav');
    assert.deepEqual(
      fs.readFileSync(path.join(recordingsDir, 'Race Artist - Race Title [race-id].wav')),
      competingPayload
    );
  });

  it('preserves finalized audio for recovery when metadata persistence fails', async () => {
    const recordingsDir = makeTempDir();
    const stagingDir = path.join(recordingsDir, '.staging');
    fs.mkdirSync(stagingDir);
    const tempPath = path.join(stagingDir, 'capture.wav');
    const payload = makeWavPayload(144);
    fs.writeFileSync(tempPath, payload);
    const expectedPath = path.join(recordingsDir, 'Recovery Artist - Recovery Track [recover01].wav');

    await assert.rejects(finalizeOwnedRecording({
      tempPath,
      recordingsDir,
      artist: 'Recovery Artist',
      title: 'Recovery Track',
      id: 'recover01',
      persistMetadata() {
        throw new Error('simulated metadata failure');
      }
    }), error => {
      assert.match(error.message, /preserved.*recovery/i);
      return true;
    });

    assert.deepEqual(fs.readFileSync(expectedPath), payload);
  });

  it('detects a staging source replacement during finalization without deleting the public artifact', async () => {
    const recordingsDir = makeTempDir();
    const stagingDir = path.join(recordingsDir, '.staging');
    fs.mkdirSync(stagingDir);
    const tempPath = path.join(stagingDir, 'capture.wav');
    fs.writeFileSync(tempPath, makeWavPayload(160));
    const replacement = makeWavPayload(48);
    const expectedPath = path.join(recordingsDir, 'Swap Artist - Swap Track [swap01].wav');

    await assert.rejects(finalizeOwnedRecording({
      tempPath,
      recordingsDir,
      artist: 'Swap Artist',
      title: 'Swap Track',
      id: 'swap01',
      persistMetadata() {},
      async linkFile(sourcePath, destinationPath) {
        await fs.promises.unlink(sourcePath);
        await fs.promises.writeFile(sourcePath, replacement, { flag: 'wx' });
        await fs.promises.link(sourcePath, destinationPath);
      }
    }), /source changed|preserved.*recovery/i);

    assert.deepEqual(fs.readFileSync(expectedPath), replacement);
    assert.deepEqual(fs.readFileSync(tempPath), replacement);
  });

  it('does not clean a foreign staging file installed during metadata persistence', async () => {
    const recordingsDir = makeTempDir();
    const stagingDir = path.join(recordingsDir, '.staging');
    fs.mkdirSync(stagingDir);
    const tempPath = path.join(stagingDir, 'capture.wav');
    const original = makeWavPayload(168);
    const replacement = Buffer.from('foreign-staging-owner');
    fs.writeFileSync(tempPath, original);

    const result = await finalizeOwnedRecording({
      tempPath,
      recordingsDir,
      artist: 'Cleanup Artist',
      title: 'Cleanup Track',
      id: 'cleanup01',
      persistMetadata() {
        fs.unlinkSync(tempPath);
        fs.writeFileSync(tempPath, replacement, { flag: 'wx' });
      }
    });

    assert.deepEqual(fs.readFileSync(result.filePath), original);
    assert.deepEqual(fs.readFileSync(tempPath), replacement);
    assert.equal(result.stagingCleanupPending, true);
  });

  it('rejects header-only or malformed WAV files before publication', async () => {
    const root = makeTempDir();
    const filePath = path.join(root, 'empty.wav');
    fs.writeFileSync(filePath, makeWavPayload(0));
    await assert.rejects(validateWavFile(filePath), /audio payload/i);
  });

  it('publishes only to configured Break-Wave storage with a sidecar and keeps the source', async () => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const sourceFilename = 'Source Artist - Source Title [source01].wav';
    const sourcePath = path.join(recordingsDir, sourceFilename);
    fs.writeFileSync(sourcePath, makeWavPayload());

    const result = await publishOwnedRecording({
      filename: sourceFilename,
      recordingsDir,
      publishDir,
      metadata: { artist: 'Published Artist', title: 'Published Title', notes: 'Owned CD transfer' },
      id: 'pub12345',
      publishedAt: '2026-08-29T13:00:00.000Z'
    });

    assert.equal(result.filename, 'Published Artist - Published Title [pub12345].wav');
    assert.equal(fs.existsSync(sourcePath), true, 'source recording must not be deleted');
    assert.equal(fs.existsSync(path.join(publishDir, result.filename)), true);
    const sidecar = JSON.parse(fs.readFileSync(path.join(publishDir, `${result.filename}.json`), 'utf8'));
    assert.equal(sidecar.sourceFilename, sourceFilename);
    assert.equal(sidecar.sourceKind, 'owned_recording');
    assert.equal(sidecar.embeddedTags, false);
  });

  it('rejects a recording pathname replaced after the source was opened', async () => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const sourceFilename = 'Source - Held Handle [held01].wav';
    const sourcePath = path.join(recordingsDir, sourceFilename);
    const replacement = makeWavPayload(40);
    fs.writeFileSync(sourcePath, makeWavPayload(200));
    let swapped = false;
    const metadata = {
      get artist() {
        if (!swapped) {
          swapped = true;
          fs.unlinkSync(sourcePath);
          fs.writeFileSync(sourcePath, replacement, { flag: 'wx' });
        }
        return 'Held Artist';
      },
      title: 'Held Track'
    };

    await assert.rejects(publishOwnedRecording({
      filename: sourceFilename,
      recordingsDir,
      publishDir,
      metadata,
      id: 'held01'
    }), /source changed/i);

    assert.deepEqual(fs.readFileSync(sourcePath), replacement);
    assert.deepEqual(fs.readdirSync(publishDir), []);
  });

  it('does not clean a foreign file that replaces its exclusive publication temp', async () => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const sourceFilename = 'Source - Temp Ownership [temp01].wav';
    fs.writeFileSync(path.join(recordingsDir, sourceFilename), makeWavPayload(180));
    const foreignPayload = Buffer.from('foreign-temp-owner');
    let replacedTempPath = null;

    await assert.rejects(publishOwnedRecording({
      filename: sourceFilename,
      recordingsDir,
      publishDir,
      metadata: { artist: 'Temp Artist', title: 'Temp Track' },
      id: 'temp01',
      async linkFile(sourcePath, destinationPath) {
        if (destinationPath.endsWith('.wav')) {
          replacedTempPath = sourcePath;
          await fs.promises.unlink(sourcePath);
          await fs.promises.writeFile(sourcePath, foreignPayload, { flag: 'wx' });
          const error = new Error('simulated publication failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.promises.link(sourcePath, destinationPath);
      }
    }), /simulated publication failure/);

    assert.ok(replacedTempPath);
    assert.deepEqual(fs.readFileSync(replacedTempPath), foreignPayload);
  });

  it('does not delete a pre-existing file when exclusive publication temp creation collides', async t => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const sourceFilename = 'Source - Temp Collision [temp02].wav';
    fs.writeFileSync(path.join(recordingsDir, sourceFilename), makeWavPayload(182));
    t.mock.method(crypto, 'randomBytes', size => Buffer.alloc(size, 0x5a));
    const collidingTempPath = path.join(publishDir, `.wavesentry-publish-${'5a'.repeat(8)}.wav`);
    const foreignPayload = Buffer.from('pre-existing-temp-owner');
    fs.writeFileSync(collidingTempPath, foreignPayload, { flag: 'wx' });

    await assert.rejects(publishOwnedRecording({
      filename: sourceFilename,
      recordingsDir,
      publishDir,
      metadata: { artist: 'Collision Artist', title: 'Temp Track' },
      id: 'temp02'
    }), /EEXIST/);

    assert.deepEqual(fs.readFileSync(collidingTempPath), foreignPayload);
  });

  it('preserves public audio and a foreign replacement when sidecar publication fails', async () => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const sourceFilename = 'Source - Sidecar Recovery [side01].wav';
    const sourcePayload = makeWavPayload(184);
    fs.writeFileSync(path.join(recordingsDir, sourceFilename), sourcePayload);
    const foreignPayload = Buffer.from('foreign-sidecar-temp-owner');
    const expectedAudioPath = path.join(publishDir, 'Sidecar Recovery - Track [side01].wav');
    let replacedSidecarTempPath = null;

    await assert.rejects(publishOwnedRecording({
      filename: sourceFilename,
      recordingsDir,
      publishDir,
      metadata: { artist: 'Sidecar Recovery', title: 'Track' },
      id: 'side01',
      async linkFile(sourcePath, destinationPath) {
        if (destinationPath.endsWith('.wav')) {
          return fs.promises.link(sourcePath, destinationPath);
        }
        replacedSidecarTempPath = sourcePath;
        await fs.promises.unlink(sourcePath);
        await fs.promises.writeFile(sourcePath, foreignPayload, { flag: 'wx' });
        const error = new Error('simulated sidecar failure');
        error.code = 'EIO';
        throw error;
      }
    }), /preserved.*recovery/i);

    assert.deepEqual(fs.readFileSync(expectedAudioPath), sourcePayload);
    assert.ok(replacedSidecarTempPath);
    assert.deepEqual(fs.readFileSync(replacedSidecarTempPath), foreignPayload);
  });

  it('does not delete a pre-existing file when exclusive sidecar temp creation collides', async t => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const sourceFilename = 'Source - Sidecar Collision [side02].wav';
    const sourcePayload = makeWavPayload(186);
    fs.writeFileSync(path.join(recordingsDir, sourceFilename), sourcePayload);
    t.mock.method(crypto, 'randomBytes', size => Buffer.alloc(size, 0x6b));
    const expectedAudioPath = path.join(publishDir, 'Sidecar Collision - Track [side02].wav');
    const collidingTempPath = `${expectedAudioPath}.json.${'6b'.repeat(4)}.tmp`;
    const foreignPayload = Buffer.from('pre-existing-sidecar-temp-owner');
    fs.writeFileSync(collidingTempPath, foreignPayload, { flag: 'wx' });

    await assert.rejects(publishOwnedRecording({
      filename: sourceFilename,
      recordingsDir,
      publishDir,
      metadata: { artist: 'Sidecar Collision', title: 'Track' },
      id: 'side02'
    }), /preserved.*recovery/i);

    assert.deepEqual(fs.readFileSync(expectedAudioPath), sourcePayload);
    assert.deepEqual(fs.readFileSync(collidingTempPath), foreignPayload);
  });

  it('retries publication without overwriting a destination created after selection', async () => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const sourceFilename = 'Source - Race [source02].wav';
    fs.writeFileSync(path.join(recordingsDir, sourceFilename), makeWavPayload());
    const competingPayload = makeWavPayload(24);
    let injectedRace = false;

    const result = await publishOwnedRecording({
      filename: sourceFilename,
      recordingsDir,
      publishDir,
      metadata: { artist: 'Publish Race', title: 'Track' },
      id: 'pub-race',
      async linkFile(sourcePath, destinationPath) {
        if (!injectedRace && destinationPath.endsWith('.wav')) {
          injectedRace = true;
          await fs.promises.writeFile(destinationPath, competingPayload, { flag: 'wx' });
          const error = new Error('simulated late collision');
          error.code = 'EEXIST';
          throw error;
        }
        return fs.promises.link(sourcePath, destinationPath);
      }
    });

    assert.equal(result.filename, 'Publish Race - Track [pub-race-2].wav');
    assert.deepEqual(
      fs.readFileSync(path.join(publishDir, 'Publish Race - Track [pub-race].wav')),
      competingPayload
    );
  });

  it('does not overwrite a pre-existing publication sidecar or create its paired audio name', async () => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const sourceFilename = 'Source - Sidecar [source03].wav';
    fs.writeFileSync(path.join(recordingsDir, sourceFilename), makeWavPayload());
    const firstAudio = path.join(publishDir, 'Sidecar Artist - Track [sidecar1].wav');
    const firstSidecar = `${firstAudio}.json`;
    fs.writeFileSync(firstSidecar, '{"owner":"external"}\n', { flag: 'wx' });

    const result = await publishOwnedRecording({
      filename: sourceFilename,
      recordingsDir,
      publishDir,
      metadata: { artist: 'Sidecar Artist', title: 'Track' },
      id: 'sidecar1'
    });

    assert.equal(result.filename, 'Sidecar Artist - Track [sidecar1-2].wav');
    assert.equal(fs.readFileSync(firstSidecar, 'utf8'), '{"owner":"external"}\n');
    assert.equal(fs.existsSync(firstAudio), false, 'pre-existing sidecar should be skipped before audio publication');
  });

  it('rejects non-regular and symlinked publication sources', async t => {
    const recordingsDir = makeTempDir();
    const publishDir = makeTempDir();
    const directorySource = path.join(recordingsDir, 'Directory.wav');
    fs.mkdirSync(directorySource);
    await assert.rejects(publishOwnedRecording({
      filename: 'Directory.wav',
      recordingsDir,
      publishDir,
      metadata: { artist: 'No', title: 'Directory' }
    }), /regular file/i);

    const outsideDir = makeTempDir();
    const outsideFile = path.join(outsideDir, 'outside.wav');
    fs.writeFileSync(outsideFile, makeWavPayload());
    const symlinkName = 'Linked Source.wav';
    try {
      fs.symlinkSync(outsideFile, path.join(recordingsDir, symlinkName), 'file');
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('File symlinks require Windows Developer Mode or elevated privileges');
        return;
      }
      throw error;
    }
    await assert.rejects(publishOwnedRecording({
      filename: symlinkName,
      recordingsDir,
      publishDir,
      metadata: { artist: 'No', title: 'Symlink' }
    }), /symbolic link|regular file/i);
  });
});
