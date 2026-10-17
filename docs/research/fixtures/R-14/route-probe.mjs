// R-14 fixture — the DEAD-PROXY ROUTE DISCRIMINATOR.
//
// Why this file exists: the original R-14 fixture pointed HTTP_PROXY at a *working* proxy, so a
// proxied request and a direct request both returned 200 and the only way to tell them apart was
// to correlate lines in a separate proxy log. Fact-check finding F12 called that inference rather
// than observation, and it was right. Here the proxy URL points at a port with NO LISTENER, so the
// two routes produce mechanically different outcomes in this process's own output:
//
//   * request dialled the proxy  -> ECONNREFUSED   (nothing is listening there)  => PROXIED
//   * request dialled DEST       -> 200 + body     (DEST is a live server)       => DIRECT
//
// A third discriminator is used for the NO_PROXY hostname-grammar cases, which need a *name*
// rather than an IP: the target host is under the reserved `.invalid` TLD (RFC 2606 §2), which is
// guaranteed never to resolve. If the request is proxied, this process never resolves the name at
// all and fails with ECONNREFUSED against the dead proxy; if it bypasses the proxy, this process
// resolves the name itself and fails with ENOTFOUND/EAI_AGAIN. Opposite error codes, same request.
//
// Usage: node route-probe.mjs <fetch|http> <url> [mutation ...]
//
// Mutations run AFTER Node has finished booting and BEFORE the request is issued, which is the
// whole point: they model a supervisor or user script trying to change proxy configuration
// post-launch. Supported mutations:
//
//   env:NAME=VALUE           process.env.NAME = VALUE
//   env-del:NAME             delete process.env.NAME
//   setGlobalProxyFromEnv    http.setGlobalProxyFromEnv()            (defaults to process.env)
//   setGlobalProxyFromEnv:{} http.setGlobalProxyFromEnv(<parsed JSON>)
//   restore                  call the restore function the last setGlobalProxyFromEnv returned
//   agent:{}                 http/https client only: issue the request through
//                            new Agent({ proxyEnv: <parsed JSON> }) instead of the global agent
//
// This script never reads a port file and never assumes a fixed port; route-suite.mjs supplies
// every address on the command line and in the environment.
import http from 'node:http';
import https from 'node:https';

const client = process.argv[2];
const url = process.argv[3];
const mutations = process.argv.slice(4);

console.log(
  `node=${process.version} undici=${process.versions.undici} platform=${process.platform} execArgv=${JSON.stringify(process.execArgv)}`,
);
console.log(`client=${client} url=${url}`);
console.log(
  `boot env: NODE_USE_ENV_PROXY=${JSON.stringify(process.env.NODE_USE_ENV_PROXY ?? null)}` +
    ` NODE_OPTIONS=${JSON.stringify(process.env.NODE_OPTIONS ?? null)}` +
    ` HTTP_PROXY=${JSON.stringify(process.env.HTTP_PROXY ?? null)}` +
    ` http_proxy=${JSON.stringify(process.env.http_proxy ?? null)}` +
    ` HTTPS_PROXY=${JSON.stringify(process.env.HTTPS_PROXY ?? null)}` +
    ` ALL_PROXY=${JSON.stringify(process.env.ALL_PROXY ?? null)}` +
    ` NO_PROXY=${JSON.stringify(process.env.NO_PROXY ?? null)}`,
);

let restoreFn = null;
let agent;

for (const m of mutations) {
  if (m.startsWith('env:')) {
    const eq = m.indexOf('=');
    const name = m.slice(4, eq);
    const value = m.slice(eq + 1);
    process.env[name] = value;
    console.log(`mutation: process.env.${name} = ${JSON.stringify(value)}`);
  } else if (m.startsWith('env-del:')) {
    const name = m.slice(8);
    delete process.env[name];
    console.log(`mutation: delete process.env.${name}`);
  } else if (m === 'setGlobalProxyFromEnv') {
    restoreFn = http.setGlobalProxyFromEnv();
    console.log(
      `mutation: http.setGlobalProxyFromEnv()  -> typeof return = ${typeof restoreFn}`,
    );
  } else if (m.startsWith('setGlobalProxyFromEnv:')) {
    const arg = JSON.parse(m.slice('setGlobalProxyFromEnv:'.length));
    restoreFn = http.setGlobalProxyFromEnv(arg);
    console.log(
      `mutation: http.setGlobalProxyFromEnv(${JSON.stringify(arg)})  -> typeof return = ${typeof restoreFn}`,
    );
  } else if (m === 'restore') {
    restoreFn();
    console.log('mutation: called the restore function returned by setGlobalProxyFromEnv()');
  } else if (m.startsWith('agent:')) {
    const proxyEnv = JSON.parse(m.slice('agent:'.length));
    const Ctor = url.startsWith('https:') ? https.Agent : http.Agent;
    agent = new Ctor({ proxyEnv });
    console.log(`mutation: new Agent({ proxyEnv: ${JSON.stringify(proxyEnv)} })`);
  } else {
    console.log(`UNKNOWN MUTATION ${m}`);
    process.exit(2);
  }
}

// The verdict is computed mechanically from the outcome, not asserted by the author.
// See the header comment for the three-way mapping.
function verdict(kind, detail) {
  const codes = String(detail);
  if (kind === 'ok-200') return 'PROXY NOT USED — went DIRECT to DEST (200 from DEST itself)';
  if (kind === 'ok-407')
    return 'PROXY USED — the proxy answered 407 Proxy Authentication Required';
  if (kind === 'ok-other') return `INDETERMINATE — unexpected status ${codes}`;
  if (codes.includes('ECONNREFUSED'))
    return 'PROXY USED — dialled the configured proxy address, which has no listener (ECONNREFUSED)';
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN'))
    return 'PROXY NOT USED — resolved the target hostname itself and DNS failed (name is .invalid)';
  return `INDETERMINATE — ${codes}`;
}

function codeOf(e) {
  const parts = [];
  for (let cur = e; cur; cur = cur.cause) {
    if (cur.code) parts.push(cur.code);
    if (cur.errors) for (const sub of cur.errors) if (sub?.code) parts.push(sub.code);
  }
  return parts.length ? parts.join('/') : e.message;
}

if (client === 'fetch') {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    console.log(`RESULT: fetch resolved status=${res.status} body=${JSON.stringify(body)}`);
    console.log(
      `VERDICT: ${verdict(res.status === 200 ? 'ok-200' : res.status === 407 ? 'ok-407' : 'ok-other', res.status)}`,
    );
  } catch (e) {
    const code = codeOf(e);
    console.log(`RESULT: fetch threw ${e.constructor.name}: ${e.message} [${code}]`);
    console.log(`VERDICT: ${verdict('threw', code)}`);
  }
} else if (client === 'http') {
  const mod = url.startsWith('https:') ? https : http;
  await new Promise((resolve) => {
    const opts = { timeout: 5000 };
    if (agent) opts.agent = agent;
    const req = mod.get(url, opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        console.log(
          `RESULT: ${url.startsWith('https:') ? 'https' : 'http'}.get resolved status=${res.statusCode} body=${JSON.stringify(body)}`,
        );
        console.log(
          `VERDICT: ${verdict(res.statusCode === 200 ? 'ok-200' : res.statusCode === 407 ? 'ok-407' : 'ok-other', res.statusCode)}`,
        );
        resolve();
      });
    });
    req.on('timeout', () => {
      req.destroy();
      console.log('RESULT: request timed out');
      console.log('VERDICT: INDETERMINATE — timed out');
      resolve();
    });
    req.on('error', (e) => {
      const code = codeOf(e);
      console.log(`RESULT: request errored ${e.message} [${code}]`);
      console.log(`VERDICT: ${verdict('threw', code)}`);
      resolve();
    });
  });
} else {
  console.log(`unknown client ${client}`);
  process.exit(2);
}
