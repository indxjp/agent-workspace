import { query, InMemorySessionStore } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';

const CFG = path.resolve('./cfg');
const store = new InMemorySessionStore();
const seen = [];
let sessionId;

for await (const m of query({
  prompt: 'Reply with exactly the word: PONG',
  options: {
    cwd: process.cwd(),
    maxTurns: 1,
    tools: [],
    settingSources: [],
    sessionStore: store,
    env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
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
const walk = (d, depth = 0) => {
  if (depth > 4) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    console.log('CFG:', p.replace(CFG, '$CLAUDE_CONFIG_DIR'));
    if (e.isDirectory()) walk(p, depth + 1);
  }
};
walk(CFG);
// store contents
const keys = await store.listSessions(store ? '' : '');
console.log('storeSize:', store.size);
