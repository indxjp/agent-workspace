// R-01 fact-check round 1, probe 3: does CLAUDE_CODE_PROJECT_DIR_NAME actually
// change SessionKey.projectKey, and does an Options.projectKey exist?
import { query, InMemorySessionStore } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = path.join(process.cwd(), 'cfg3');
fs.rmSync(cfg, { recursive: true, force: true });
fs.mkdirSync(cfg, { recursive: true });
// seed auth so the temp config dir does not fail with "Not logged in"
const real = path.join(os.homedir(), '.claude');
for (const f of ['.credentials.json', 'settings.json']) {
  const src = path.join(real, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(cfg, f));
}
const dotClaudeJson = path.join(os.homedir(), '.claude.json');
if (fs.existsSync(dotClaudeJson)) fs.copyFileSync(dotClaudeJson, path.join(cfg, '.claude.json'));

const store = new InMemorySessionStore();
const keysSeen = new Set();
const origAppend = store.append.bind(store);
store.append = async (key, entries) => { keysSeen.add(JSON.stringify({ p: key.projectKey, s: key.subpath ?? null })); return origAppend(key, entries); };

let sessionId;
for await (const m of query({
  prompt: 'Reply with exactly the word PONG and nothing else.',
  options: {
    cwd: process.cwd(),
    maxTurns: 1,
    tools: [],
    settingSources: [],
    sessionStore: store,
    model: 'claude-haiku-4-5',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_PROJECT_DIR_NAME: 'tenant-a' },
  },
})) {
  if (m.type === 'result') { sessionId = m.session_id; console.log('RESULT_SUBTYPE:', m.subtype); }
  if (m.type === 'system' && m.subtype === 'mirror_error') console.log('MIRROR_ERROR:', m.error);
}
console.log('SESSION:', sessionId);
console.log('APPEND_KEYS:', JSON.stringify([...keysSeen]));
console.log('SANITISED_CWD_WOULD_BE:', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
console.log('STORE_SESSIONS_UNDER_tenant-a:', JSON.stringify(await store.listSessions('tenant-a')));
console.log('CFG_PROJECT_DIRS:', fs.existsSync(path.join(cfg, 'projects')) ? fs.readdirSync(path.join(cfg, 'projects')).join(', ') : '(none)');
