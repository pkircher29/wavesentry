const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

describe('owned-source Break-Wave UI', () => {
  it('collects artist and title instead of a system-capture prefix', () => {
    assert.match(html, /id="recording-artist"/);
    assert.match(html, /id="recording-title"/);
    assert.doesNotMatch(html, /id="filename-prefix"/);
    assert.match(app, /artist:\s*artist/);
    assert.match(app, /title:\s*title/);
  });

  it('offers the configured publish action and states the ownership boundary', () => {
    assert.match(app, /\/publish/);
    assert.match(app, /publish-btn/);
    assert.match(html, /purchased files directly to Auto-KJ/i);
    assert.match(html, /does not support capturing or ripping streaming services/i);
  });

  it('does not advertise loopback or Spotify capture', () => {
    assert.doesNotMatch(html, /virtual-audio-capturer/i);
    assert.doesNotMatch(html, /WASAPI Loopback/i);
    assert.doesNotMatch(html, /Spotify/i);
    assert.doesNotMatch(app, /virtual-audio-capturer/i);
  });
});
