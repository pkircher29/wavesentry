const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wavesentry-server-'));
const recordingsDir = path.join(testRoot, 'recordings');
const publishDir = path.join(testRoot, 'break-wave');
fs.mkdirSync(recordingsDir);
fs.mkdirSync(publishDir);
process.env.RECORDINGS_DIR = recordingsDir;
process.env.BREAK_WAVE_PUBLISH_DIR = publishDir;

const {
  LOOPBACK_HOST,
  isAllowedBrowserOrigin,
  server,
  startServer,
  wss
} = require('../src/server.js');

function makeWavPayload() {
  const payload = Buffer.alloc(300);
  payload.write('RIFF', 0, 'ascii');
  payload.writeUInt32LE(payload.length - 8, 4);
  payload.write('WAVE', 8, 'ascii');
  payload.write('data', 36, 'ascii');
  payload.writeUInt32LE(payload.length - 44, 40);
  return payload;
}

describe('loopback server and Break-Wave publish API', () => {
  let port;
  let baseUrl;

  before(async () => {
    port = await startServer(0);
    baseUrl = `http://${LOOPBACK_HOST}:${port}`;
  });

  after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('binds the server to IPv4 loopback only', () => {
    assert.equal(LOOPBACK_HOST, '127.0.0.1');
    assert.equal(server.address().address, '127.0.0.1');
  });

  it('allows only exact same-port localhost browser origins', () => {
    assert.equal(isAllowedBrowserOrigin(undefined, port), true);
    assert.equal(isAllowedBrowserOrigin(`http://127.0.0.1:${port}`, port), true);
    assert.equal(isAllowedBrowserOrigin(`http://localhost:${port}`, port), true);
    assert.equal(isAllowedBrowserOrigin('https://attacker.example', port), false);
    assert.equal(isAllowedBrowserOrigin(`http://localhost.evil:${port}`, port), false);
    assert.equal(isAllowedBrowserOrigin('null', port), false);
    assert.equal(isAllowedBrowserOrigin('http://127.0.0.1:9', port), false);
  });

  it('rejects cross-origin HTTP control requests', async () => {
    const response = await fetch(`${baseUrl}/api/recordings/not-found.wav/metadata`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example'
      },
      body: JSON.stringify({ title: 'changed' })
    });
    assert.equal(response.status, 403);
  });

  it('serves the local UI with restrictive browser security headers', async () => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const integration = await fetch(`${baseUrl}/api/integration`, {
      headers: { Origin: `http://127.0.0.1:${port}` }
    });
    assert.deepEqual(await integration.json(), {
      breakWavePublishConfigured: true,
      publishMode: 'configured-directory',
      directPurchasedFileImportPreferred: true,
      streamingCaptureSupported: false
    });
  });

  it('rejects cross-origin WebSocket control connections', async () => {
    const status = await new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://${LOOPBACK_HOST}:${port}`, {
        origin: 'https://attacker.example'
      });
      client.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      client.once('open', () => reject(new Error('cross-origin WebSocket unexpectedly opened')));
      client.once('error', () => {});
    });
    assert.equal(status, 403);
  });

  it('allows the exact local UI origin to connect by WebSocket', async () => {
    const client = new WebSocket(`ws://${LOOPBACK_HOST}:${port}`, {
      origin: `http://127.0.0.1:${port}`
    });
    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    assert.equal(client.readyState, WebSocket.OPEN);
    client.close();
    await new Promise(resolve => client.once('close', resolve));
  });

  it('publishes a configured owned WAV without accepting a request destination', async () => {
    const filename = 'Owned Artist - Wait... What [source01].wav';
    fs.writeFileSync(path.join(recordingsDir, filename), makeWavPayload());
    fs.writeFileSync(path.join(recordingsDir, '.metadata.json'), JSON.stringify({
      [filename]: { artist: 'Owned Artist', title: 'Wait... What', sourceKind: 'owned_input' }
    }));

    const response = await fetch(`${baseUrl}/api/recordings/${encodeURIComponent(filename)}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({ destination: path.join(testRoot, 'attacker-controlled') })
    });
    assert.equal(response.status, 400);

    const publishResponse = await fetch(`${baseUrl}/api/recordings/${encodeURIComponent(filename)}/publish`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}` }
    });
    assert.equal(publishResponse.status, 201);
    const body = await publishResponse.json();
    assert.equal(body.success, true);
    assert.equal(fs.existsSync(path.join(recordingsDir, filename)), true);
    assert.equal(fs.existsSync(path.join(publishDir, body.filename)), true);
    assert.equal(fs.existsSync(path.join(testRoot, 'attacker-controlled')), false);
  });
});
