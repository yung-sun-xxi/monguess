#!/usr/bin/env node
// Mutation check: node scripts/mutate.js <mutations.json>
// The JSON is a list of { name, file, find, replace, expect }: `find` must occur exactly
// once in `file`; it is replaced, the unit tests run, and the file is restored from the
// copy read before the change (also on Ctrl-C). A mutation counts as killed when the test
// whose name contains `expect` fails; a run that hangs is stopped after 60 s and counts as
// not killed. Prints every failing test per mutation; exit 0 only if every mutation was
// killed by its expected test.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const listFile = process.argv[2];
if (!listFile) {
  console.error('usage: node scripts/mutate.js <mutations.json>');
  process.exit(1);
}
const TIMEOUT_MS = 60000;
const root = path.join(__dirname, '..');
const mutations = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const tests = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => `tests/${f}`);

let restore = null;
process.on('SIGINT', () => {
  if (restore) restore();
  process.exit(130);
});

let missed = 0;
for (const m of mutations) {
  const file = path.join(root, m.file);
  const original = fs.readFileSync(file, 'utf8');
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    console.log(`SKIP  ${m.name}: 'find' occurs ${count} times in ${m.file}`);
    missed++;
    continue;
  }
  restore = () => fs.writeFileSync(file, original);
  let failed;
  try {
    fs.writeFileSync(file, original.replace(m.find, () => m.replace));
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests],
      { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
    failed = [...(run.stdout || '').matchAll(/^not ok \d+ - (.+)$/gm)].map((x) => x[1]).filter((n) => !n.startsWith('tests/'));
    if (run.error) failed.push(`(test run stopped after ${TIMEOUT_MS} ms: ${run.error.code})`);
  } finally {
    restore();
    restore = null;
  }
  const killed = failed.some((n) => n.includes(m.expect));
  if (!killed) missed++;
  console.log(`${killed ? 'KILL' : 'LIVE'}  ${m.name}`);
  for (const n of failed) console.log(`        ${n.includes(m.expect) ? '*' : '-'} ${n}`);
  if (!failed.length) console.log('        (no test failed)');
}
console.log(`${mutations.length - missed}/${mutations.length} killed by the expected test`);
process.exit(missed ? 1 : 0);
