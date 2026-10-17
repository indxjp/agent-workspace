import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';

const dump = (tag, e) => console.log(tag, JSON.stringify({
  ctor: e?.constructor?.name, name: e?.name, code: e?.code, data: e?.data,
  message: e?.message, own: Object.getOwnPropertyNames(e),
  eventType: e?.event?.constructor?.name, eventCode: e?.event?.code, eventMessage: e?.event?.message,
  isSseError: e instanceof SseError,
}, null, 1));

// (a) client-side timeout
{
  const c = new Client({name:'p',version:'1'},{capabilities:{}});
  try { await c.connect(new StdioClientTransport({command:process.execPath,args:['server-stdio.mjs','--mode','hang'],stderr:'pipe'}),{timeout:1500}); }
  catch(e){ dump('CLIENT-TIMEOUT', e); }
  try{await c.close()}catch{}
}
// (b) server-sent -32001 during initialize
{
  const c = new Client({name:'p',version:'1'},{capabilities:{}});
  try { await c.connect(new StdioClientTransport({command:process.execPath,args:['server-stdio.mjs','--mode','ok','--require-env','MCP_TOKEN=x'],env:{...process.env},stderr:'pipe'}),{timeout:4000}); }
  catch(e){ dump('SERVER-SENT-32001', e); }
  try{await c.close()}catch{}
}
// (c) SSE network failure
{
  const c = new Client({name:'p',version:'1'},{capabilities:{}});
  try { await c.connect(new SSEClientTransport(new URL('http://127.0.0.1:8999/sse')),{timeout:3000}); }
  catch(e){ dump('SSE-ECONNREFUSED', e); }
  try{await c.close()}catch{}
}


// (d) stdio env semantics: does StdioServerParameters.env replace or overlay?
{
  const { DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  console.log('DEFAULT_INHERITED_ENV_VARS', JSON.stringify(DEFAULT_INHERITED_ENV_VARS));
  console.log('getDefaultEnvironment keys', JSON.stringify(Object.keys(getDefaultEnvironment())));

  const { Client: C2 } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport: T2 } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  // A "server" that just reports whether PATH survived, then exits.
  for (const [label, env] of [['no env given', undefined], ['env: {API_KEY} only', { API_KEY: 'k' }]]) {
    const t = new T2({ command: process.execPath, args: ['server-env-report.mjs'], env, stderr: 'pipe' });
    let err = '';
    const c = new C2({ name: 'p', version: '1' }, { capabilities: {} });
    const origStart = t.start.bind(t);
    t.start = async () => { await origStart(); t.stderr?.on('data', (b) => (err += b)); };
    try { await c.connect(t, { timeout: 3000 }); } catch {}
    await new Promise((r) => setTimeout(r, 400));
    console.log(`STDIO-ENV [${label}] child saw: ${err.trim() || '(nothing)'}`);
    try { await c.close(); } catch {}
  }
}
process.exit(0);
