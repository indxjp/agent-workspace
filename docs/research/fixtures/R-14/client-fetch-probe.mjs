// R-14 fixture — client half. Env vars (HTTP_PROXY / HTTPS_PROXY / NODE_USE_ENV_PROXY) must be
// exported before `node` starts (see probe-fetch-proxy-shellenv.mjs for why: the proxy target is
// snapshotted at process bootstrap, not read lazily from process.env on first use).
// Usage: node client-fetch-probe.mjs <fetch|http> <url>
import http from 'node:http';
import https from 'node:https';

const mode = process.argv[2];
const url = process.argv[3];
const httpMod = url.startsWith('https:') ? https : http;

console.log(`node=${process.version} execArgv=${JSON.stringify(process.execArgv)} mode=${mode} url=${url}`);
console.log(`NODE_USE_ENV_PROXY=${JSON.stringify(process.env.NODE_USE_ENV_PROXY ?? null)} HTTP_PROXY=${JSON.stringify(process.env.HTTP_PROXY ?? null)} HTTPS_PROXY=${JSON.stringify(process.env.HTTPS_PROXY ?? null)} NO_PROXY=${JSON.stringify(process.env.NO_PROXY ?? null)}`);

if (mode === 'fetch') {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    console.log(`RESULT: fetch resolved status=${res.status} body=${JSON.stringify(await res.text())}`);
  } catch (e) {
    console.log(`RESULT: fetch threw ${e.constructor.name}: ${e.message}`);
  }
} else if (mode === 'http') {
  await new Promise((resolve) => {
    const req = httpMod.get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { console.log(`RESULT: http.get resolved status=${res.statusCode} body=${JSON.stringify(body)}`); resolve(); });
    });
    req.on('timeout', () => { req.destroy(); console.log('RESULT: http.get timed out'); resolve(); });
    req.on('error', (e) => { console.log(`RESULT: http.get errored ${e.message}`); resolve(); });
  });
} else {
  console.log('unknown mode');
}
