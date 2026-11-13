import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'playwright-install.sh');

/**
 * A fake `playwright` that fails with the given outputs in turn, then succeeds.
 * @param {ReadonlyArray<{ out: string, code: number }>} failures
 */
function fake(failures) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-install-'));
  const counter = join(dir, 'calls');
  writeFileSync(counter, '0');
  const bin = join(dir, 'playwright');
  const cases = failures
    .map((f, i) => `  ${i + 1}) echo ${JSON.stringify(f.out)}; exit ${f.code} ;;`)
    .join('\n');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
n=$(( $(cat ${JSON.stringify(counter)}) + 1 )); echo "$n" > ${JSON.stringify(counter)}
echo "args: $*"
case "$n" in
${cases}
  *) echo installed; exit 0 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => Number(readFileSync(counter, 'utf8').trim()) };
}

/** @param {string} bin @param {string[]} argv @param {Record<string, string>} [env] */
function run(bin, argv, env = {}) {
  return spawnSync('bash', [script, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AW_PLAYWRIGHT_COMMAND: bin,
      AW_APT_LOCK_DELAY_SECONDS: '0',
      ...env,
    },
  });
}

const lock = {
  out: 'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 2063486 (apt-get)',
  code: 100,
};

test('runs once and passes the right arguments when nothing holds the lock', () => {
  const f = fake([]);
  const r = run(f.bin, ['install']);
  assert.equal(r.status, 0);
  assert.equal(f.calls(), 1);
  assert.match(r.stdout, /args: install --with-deps chromium/);
  const d = fake([]);
  assert.match(run(d.bin, ['install-deps']).stdout, /args: install-deps chromium/);
});

test('waits and tries again while another job holds the apt lock', () => {
  const f = fake([lock, { out: 'E: Unable to acquire the dpkg frontend lock', code: 100 }]);
  const r = run(f.bin, ['install']);
  assert.equal(r.status, 0);
  assert.equal(f.calls(), 3);
  assert.match(r.stderr, /attempt 1 of 8/);
});

test('a failure that is not the lock is returned at once, unchanged', () => {
  const f = fake([{ out: 'Failed to download Chromium: ECONNRESET', code: 1 }]);
  const r = run(f.bin, ['install']);
  assert.equal(r.status, 1);
  assert.equal(f.calls(), 1);
});

test('gives up after the last attempt with the original exit code', () => {
  const f = fake([lock, lock, lock, lock]);
  const r = run(f.bin, ['install'], { AW_APT_LOCK_ATTEMPTS: '3' });
  assert.equal(r.status, 100);
  assert.equal(f.calls(), 3);
  assert.match(r.stderr, /still held by another process after 3 attempts/);
});

test('rejects an unknown mode', () => {
  const f = fake([]);
  const r = run(f.bin, ['--with-deps']);
  assert.equal(r.status, 2);
  assert.equal(f.calls(), 0);
});
