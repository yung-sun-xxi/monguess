'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// scripts/deploy.sh copies the site file by file; a script or stylesheet index.html loads but the
// copy leaves out is missing in production (fx.js was, on 2026-10-22). config.js is built there.
test('deploy.sh copies every local file index.html loads', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, 'scripts/deploy.sh'), 'utf8');
  const copied = deploy.match(/^cp ([^\n]*) "\$out"\/$/m)[1].split(/\s+/);
  const loaded = [...html.matchAll(/(?:src|href)="([^":]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(loaded.includes('app.js'), loaded.join(' '));
  for (const file of loaded) {
    if (file !== 'config.js') assert.ok(copied.includes(file), `${file} is loaded but not deployed`);
  }
});
