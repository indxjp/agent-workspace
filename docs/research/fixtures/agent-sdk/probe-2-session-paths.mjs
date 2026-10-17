import { query, InMemorySessionStore } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const store = new InMemorySessionStore();
const seen = [];
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
  },
})) {
  seen.push(m.type + (m.subtype ? '/' + m.subtype : ''));
  if (m.type === 'system' && m.subtype === 'init') {
    sessionId = m.session_id;
    fs.writeFileSync('init.json', JSON.stringify(m, null, 2));
  }
  if (m.type === 'result') {
    sessionId = m.session_id;
    fs.writeFileSync('result.json', JSON.stringify(m, null, 2));
  }
}
console.log('EVENTS:', JSON.stringify(seen));
console.log('SESSION:', sessionId);
const enc = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const dir = path.join(os.homedir(), '.claude', 'projects', enc);
console.log('LOCAL_DIR:', dir, 'exists=', fs.existsSync(dir));
if (fs.existsSync(dir)) console.log('LOCAL_FILES:', fs.readdirSync(dir).join(', '));
console.log('STORE_SIZE:', store.size);
console.log('STORE_SESSIONS:', JSON.stringify(await store.listSessions(enc)));
const entries = await store.load({ projectKey: enc, sessionId });
console.log('STORE_ENTRY_TYPES:', entries ? JSON.stringify(entries.map((e) => e.type)) : 'null');
