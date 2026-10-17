// R-14 probe — plain node:child_process.spawn with NO env override: does the child inherit
// HTTP_PROXY / NODE_USE_ENV_PROXY from the parent's process.env, and does fetch() inside that
// child then honour them? This is the raw OS/Node baseline that MCP's stdio transport allowlist
// (R-06, DEFAULT_INHERITED_ENV_VARS) deliberately narrows away from.
import { spawn } from 'node:child_process';

const destPort = Number(process.argv[2]);
const proxyPort = Number(process.argv[3]);

console.log(`PARENT node=${process.version} NODE_USE_ENV_PROXY=${JSON.stringify(process.env.NODE_USE_ENV_PROXY ?? null)} HTTP_PROXY=${JSON.stringify(process.env.HTTP_PROXY ?? null)}`);

const child = spawn(process.execPath, ['client-fetch-probe.mjs', 'fetch', `http://127.0.0.1:${destPort}/childpath`], {
  // No `env` key at all -> Node's documented default is "inherit from process.env"
  stdio: 'inherit',
});

await new Promise((resolve) => child.on('exit', resolve));
