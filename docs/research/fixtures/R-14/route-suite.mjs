// R-14 fixture — runs every DEAD-PROXY route probe and prints one transcript.
//
//   node route-suite.mjs
//
// Pure Node, no shell, no openssl, no port files, no fixed ports: this is the half of the R-14
// fixture set that runs unchanged inside the pinned runtime image, which is how the "no probe ran
// inside a real container" and "lowercase precedence could not be probed on Windows" gaps get
// closed. From this directory:
//
//   docker run --rm -v "$PWD":/fx -w /fx node:24.19.0-bookworm-slim node route-suite.mjs
//
// Design, in one paragraph. Two addresses are allocated up front. DEST is a live plain-HTTP server
// in a child process, bound to 127.0.0.1 on an OS-assigned port; it answers every path with
// `hello from DEST`. DEAD is a second OS-assigned port that is bound, its number read, and then
// closed, so nothing is listening on it for the rest of the run. Every probe below points its
// proxy variables at DEAD. A request that is proxied therefore dies with ECONNREFUSED, and a
// request that is not proxied reaches DEST and returns 200. There is no log to correlate and no
// inference step: each probe's own stdout says which of the two happened. Probes whose subject is
// NO_PROXY's *hostname* grammar aim at a name under the reserved `.invalid` TLD instead, where the
// two outcomes are ECONNREFUSED (proxied — the name was never resolved) and ENOTFOUND (not
// proxied — this process resolved it and DNS said no). See route-probe.mjs's header.
//
// Every probe is its own `node` process, because the enabling mechanisms under test
// (NODE_USE_ENV_PROXY, --use-env-proxy, NODE_OPTIONS) are read during Node's bootstrap and cannot
// be changed afterwards from inside a running process — which is itself one of the things this
// suite proves.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function freePortThenClose() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

const dest = spawn(process.execPath, [path.join(here, 'dest-server.mjs'), '0'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const destPort = await new Promise((resolve) => {
  let buf = '';
  dest.stdout.on('data', (c) => {
    buf += c;
    const m = buf.match(/DEST listening on 127\.0\.0\.1:(\d+)/);
    if (m) resolve(Number(m[1]));
  });
});
const deadPort = await freePortThenClose();
const deadPort2 = await freePortThenClose();
const DEAD = `http://127.0.0.1:${deadPort}`;
// A SECOND dead port, used only by the case-precedence probes: when `http_proxy` and `HTTP_PROXY`
// disagree, both candidates are dead, and the ECONNREFUSED message from the `http` module names
// the port it actually dialled — so the transcript states which variable won, rather than the
// author asserting it.
const DEAD2 = `http://127.0.0.1:${deadPort2}`;
const DESTURL = `http://127.0.0.1:${destPort}`;

console.log(`node=${process.version} platform=${process.platform}`);
console.log(`DEST (live, answers 200)          = ${DESTURL}`);
console.log(`DEAD PROXY A (no listener)        = ${DEAD}`);
console.log(`DEAD PROXY B (no listener)        = ${DEAD2}`);
console.log(
  'Mapping: ECONNREFUSED => the request was sent to the proxy. 200 from DEST => it was not.',
);

const expand = (s) =>
  s.replaceAll('{DEAD}', DEAD).replaceAll('{DEAD2}', DEAD2).replaceAll('{DESTPORT}', String(destPort));

// title, client, url, env, execArgv, mutations
const cases = [
  [
    'D1  BASELINE — fetch, NODE_USE_ENV_PROXY=1, HTTP_PROXY=DEAD',
    'fetch',
    DESTURL + '/d1',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD },
  ],
  [
    'D2  CONTROL — fetch, HTTP_PROXY=DEAD, no enabling mechanism',
    'fetch',
    DESTURL + '/d2',
    { HTTP_PROXY: DEAD },
  ],
  [
    'D3  BASELINE — http.get, NODE_USE_ENV_PROXY=1, HTTP_PROXY=DEAD',
    'http',
    DESTURL + '/d3',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD },
  ],
  [
    'D4  CONTROL — http.get, HTTP_PROXY=DEAD, no enabling mechanism',
    'http',
    DESTURL + '/d4',
    { HTTP_PROXY: DEAD },
  ],
  [
    'D5  NODE_OPTIONS=--use-env-proxy, fetch  (F4: this is the probe the note claimed and never ran)',
    'fetch',
    DESTURL + '/d5',
    { NODE_OPTIONS: '--use-env-proxy', HTTP_PROXY: DEAD },
  ],
  [
    'D6  NODE_OPTIONS=--use-env-proxy, http.get',
    'http',
    DESTURL + '/d6',
    { NODE_OPTIONS: '--use-env-proxy', HTTP_PROXY: DEAD },
  ],
  [
    'D7  --use-env-proxy CLI flag, fetch',
    'fetch',
    DESTURL + '/d7',
    { HTTP_PROXY: DEAD },
    ['--use-env-proxy'],
  ],
  [
    'D8  --use-env-proxy CLI flag, http.get',
    'http',
    DESTURL + '/d8',
    { HTTP_PROXY: DEAD },
    ['--use-env-proxy'],
  ],
  [
    'D9  POST-LAUNCH API — http.setGlobalProxyFromEnv({HTTP_PROXY}) with NO boot mechanism, fetch',
    'fetch',
    DESTURL + '/d9',
    {},
    [],
    ['setGlobalProxyFromEnv:{"HTTP_PROXY":"{DEAD}"}'],
  ],
  [
    'D10 POST-LAUNCH API — http.setGlobalProxyFromEnv({HTTP_PROXY}) with NO boot mechanism, http.get',
    'http',
    DESTURL + '/d10',
    {},
    [],
    ['setGlobalProxyFromEnv:{"HTTP_PROXY":"{DEAD}"}'],
  ],
  [
    'D11 POST-LAUNCH API — set process.env.HTTP_PROXY late, THEN setGlobalProxyFromEnv() with no argument',
    'fetch',
    DESTURL + '/d11',
    {},
    [],
    ['env:HTTP_PROXY={DEAD}', 'setGlobalProxyFromEnv'],
  ],
  [
    'D12 POST-LAUNCH API — the returned restore function puts it back',
    'fetch',
    DESTURL + '/d12',
    {},
    [],
    ['setGlobalProxyFromEnv:{"HTTP_PROXY":"{DEAD}"}', 'restore'],
  ],
  [
    'D13 POST-LAUNCH AGENT — new http.Agent({ proxyEnv }), global agent untouched',
    'http',
    DESTURL + '/d13',
    {},
    [],
    ['agent:{"HTTP_PROXY":"{DEAD}"}'],
  ],
  [
    'D14 NEGATIVE — late process.env.HTTP_PROXY mutation, booted with NODE_USE_ENV_PROXY=1, fetch',
    'fetch',
    DESTURL + '/d14',
    { NODE_USE_ENV_PROXY: '1' },
    [],
    ['env:HTTP_PROXY={DEAD}'],
  ],
  [
    'D15 NEGATIVE — late process.env.HTTP_PROXY mutation, booted with NODE_USE_ENV_PROXY=1, http.get',
    'http',
    DESTURL + '/d15',
    { NODE_USE_ENV_PROXY: '1' },
    [],
    ['env:HTTP_PROXY={DEAD}'],
  ],
  [
    'D16 NO_PROXY LIVENESS, fetch — NO_PROXY unset at boot, set from inside the process afterwards',
    'fetch',
    DESTURL + '/d16',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD },
    [],
    ['env:NO_PROXY=127.0.0.1'],
  ],
  [
    'D17 NO_PROXY LIVENESS, http.get — same mutation, same moment, DIFFERENT ANSWER',
    'http',
    DESTURL + '/d17',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD },
    [],
    ['env:NO_PROXY=127.0.0.1'],
  ],
  [
    'D18 CONTROL for D16 — NO_PROXY=127.0.0.1 present at boot, fetch',
    'fetch',
    DESTURL + '/d18',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '127.0.0.1' },
  ],
  [
    'D19 CONTROL for D17 — NO_PROXY=127.0.0.1 present at boot, http.get',
    'http',
    DESTURL + '/d19',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '127.0.0.1' },
  ],
  [
    'D20 NO_PROXY=* — fetch',
    'fetch',
    DESTURL + '/d20',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '*' },
  ],
  [
    'D21 NO_PROXY=* — http.get',
    'http',
    DESTURL + '/d21',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '*' },
  ],
  [
    'D22 NO_PROXY port qualifier MATCHING the destination port — fetch',
    'fetch',
    DESTURL + '/d22',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: `127.0.0.1:${destPort}` },
  ],
  [
    'D23 NO_PROXY port qualifier NOT matching the destination port — fetch',
    'fetch',
    DESTURL + '/d23',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '127.0.0.1:1' },
  ],
  [
    'D24 NO_PROXY port qualifier MATCHING the destination port — http.get',
    'http',
    DESTURL + '/d24',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: `127.0.0.1:${destPort}` },
  ],
  [
    'D25 NO_PROXY port qualifier NOT matching — http.get',
    'http',
    DESTURL + '/d25',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '127.0.0.1:1' },
  ],
  // The .invalid target: ECONNREFUSED = proxied, ENOTFOUND = bypassed. See route-probe.mjs header.
  [
    'D26 SUBDOMAIN CONTROL — no NO_PROXY, host under .invalid, fetch',
    'fetch',
    'http://sub.r14-probe.invalid/d26',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD },
  ],
  [
    'D27 NO_PROXY=.r14-probe.invalid (leading dot) vs sub.r14-probe.invalid, fetch',
    'fetch',
    'http://sub.r14-probe.invalid/d27',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '.r14-probe.invalid' },
  ],
  [
    'D28 NO_PROXY=r14-probe.invalid (no dot) vs sub.r14-probe.invalid, fetch',
    'fetch',
    'http://sub.r14-probe.invalid/d28',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: 'r14-probe.invalid' },
  ],
  [
    'D29 NO_PROXY=*.r14-probe.invalid (wildcard) vs sub.r14-probe.invalid, fetch',
    'fetch',
    'http://sub.r14-probe.invalid/d29',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '*.r14-probe.invalid' },
  ],
  [
    'D30 NO_PROXY=other.invalid (no match) vs sub.r14-probe.invalid, fetch',
    'fetch',
    'http://sub.r14-probe.invalid/d30',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: 'other.invalid' },
  ],
  [
    'D31 NO_PROXY=.r14-probe.invalid vs sub.r14-probe.invalid, http.get',
    'http',
    'http://sub.r14-probe.invalid/d31',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '.r14-probe.invalid' },
  ],
  [
    'D32 NO_PROXY exact-host case-insensitivity — NO_PROXY=SUB.R14-PROBE.INVALID, fetch',
    'fetch',
    'http://sub.r14-probe.invalid/d32',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: 'SUB.R14-PROBE.INVALID' },
  ],
  [
    'D33 ALL_PROXY only (no HTTP_PROXY), NODE_USE_ENV_PROXY=1, fetch',
    'fetch',
    DESTURL + '/d33',
    { NODE_USE_ENV_PROXY: '1', ALL_PROXY: DEAD },
  ],
  [
    'D34 ALL_PROXY only (no HTTP_PROXY), NODE_USE_ENV_PROXY=1, http.get',
    'http',
    DESTURL + '/d34',
    { NODE_USE_ENV_PROXY: '1', ALL_PROXY: DEAD },
  ],
  // Lowercase precedence. On Windows D35-D39 are structurally incapable of answering the question,
  // because the OS folds environment-variable case — and the transcript's own `boot env:` line
  // proves it rather than merely asserting it: `HTTP_PROXY` and `http_proxy` read back the SAME
  // value whichever one was exported. On Linux they are the real test. That is exactly why this
  // suite is run twice, on the Windows host and inside `node:24.19.0-bookworm-slim`, and both
  // transcripts are committed side by side.
  [
    'D35 LOWERCASE PRECEDENCE — http_proxy=DEAD-A, HTTP_PROXY=DEAD-B (disagreeing), http.get names the port it dialled',
    'http',
    DESTURL + '/d35',
    { NODE_USE_ENV_PROXY: '1', http_proxy: DEAD, HTTP_PROXY: DEAD2 },
  ],
  [
    'D36 LOWERCASE PRECEDENCE, fetch — decided through no_proxy instead, since fetch does not name the port',
    'fetch',
    DESTURL + '/d36',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, no_proxy: '127.0.0.1', NO_PROXY: 'example.com' },
  ],
  [
    'D37 LOWERCASE PRECEDENCE, http.get — same no_proxy/NO_PROXY disagreement',
    'http',
    DESTURL + '/d37',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, no_proxy: '127.0.0.1', NO_PROXY: 'example.com' },
  ],
  [
    'D38 LOWERCASE ONLY — http_proxy=DEAD-A set, HTTP_PROXY unset, fetch',
    'fetch',
    DESTURL + '/d38',
    { NODE_USE_ENV_PROXY: '1', http_proxy: DEAD },
  ],
  [
    'D39 LOWERCASE ONLY — http_proxy=DEAD-A set, HTTP_PROXY unset, http.get',
    'http',
    DESTURL + '/d39',
    { NODE_USE_ENV_PROXY: '1', http_proxy: DEAD },
  ],
  // D40-D45 exist because the two layers do NOT share a NO_PROXY implementation, and reading both
  // sources side by side turns up three grammar differences that a single "NO_PROXY matching
  // rules" row would paper over. Each is probed on both layers so the note can state them per
  // layer instead of averaging them.
  [
    'D40 BARE SUFFIX — NO_PROXY=r14-probe.invalid (no dot) vs sub.r14-probe.invalid, http.get (compare D28, fetch)',
    'http',
    'http://sub.r14-probe.invalid/d40',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: 'r14-probe.invalid' },
  ],
  [
    'D41 WILDCARD — NO_PROXY=*.r14-probe.invalid vs sub.r14-probe.invalid, http.get (compare D29, fetch)',
    'http',
    'http://sub.r14-probe.invalid/d41',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '*.r14-probe.invalid' },
  ],
  [
    'D42 IP RANGE — NO_PROXY=127.0.0.0-127.0.0.255 vs 127.0.0.1, fetch',
    'fetch',
    DESTURL + '/d42',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '127.0.0.0-127.0.0.255' },
  ],
  [
    'D43 IP RANGE — NO_PROXY=127.0.0.0-127.0.0.255 vs 127.0.0.1, http.get',
    'http',
    DESTURL + '/d43',
    { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: DEAD, NO_PROXY: '127.0.0.0-127.0.0.255' },
  ],
  [
    'D44 EMPTY STRING — http_proxy="" and HTTP_PROXY=DEAD-A, fetch',
    'fetch',
    DESTURL + '/d44',
    { NODE_USE_ENV_PROXY: '1', http_proxy: '', HTTP_PROXY: DEAD },
  ],
  [
    'D45 EMPTY STRING — http_proxy="" and HTTP_PROXY=DEAD-A, http.get',
    'http',
    DESTURL + '/d45',
    { NODE_USE_ENV_PROXY: '1', http_proxy: '', HTTP_PROXY: DEAD },
  ],
];

const CLEAR = [
  'NODE_USE_ENV_PROXY',
  'NODE_OPTIONS',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
];

for (const [title, client, url, env = {}, execArgv = [], mutations = []] of cases) {
  console.log(`\n### ${title} ###`);
  const childEnv = { ...process.env };
  for (const k of CLEAR) delete childEnv[k];
  for (const [k, v] of Object.entries(env)) childEnv[k] = v;
  const args = [...execArgv, path.join(here, 'route-probe.mjs'), client, url, ...mutations.map(expand)];
  await new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env: childEnv, stdio: 'inherit' });
    p.on('exit', resolve);
  });
}

dest.kill();
console.log('\n=== route-suite complete ===');
