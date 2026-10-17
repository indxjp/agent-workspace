// Regenerates docs/research/R-01-options.json from the shipped type definitions
// of @anthropic-ai/claude-agent-sdk. Run it from a directory that has the SDK
// installed (see README.md in this directory); it writes options.json beside
// itself, which must be byte-identical to the committed R-01-options.json.
//
// Nothing here is hand-written: every name, optionality flag, type string and
// the query signature is read out of sdk.d.ts. An earlier version hard-coded
// the query signature as `query(params: ...)` while the shipped declaration
// says `query(_params: ...)`, and the two drifted silently. Read it, never
// retype it.
import fs from 'node:fs';

const SDK_DTS =
  process.env.SDK_DTS ?? 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
const SDK_PKG =
  process.env.SDK_PKG ?? 'node_modules/@anthropic-ai/claude-agent-sdk/package.json';

const src = fs.readFileSync(SDK_DTS, 'utf8');
const lines = src.split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith('export declare type Options = {'));
if (start < 0) throw new Error('Options not found');

const out = [];
let i = start + 1;
let depth = 0;
let cur = null;
let buf = [];
for (; i < lines.length; i++) {
  const raw = lines[i];
  if (depth === 0 && raw === '};') break;
  if (depth === 0) {
    const m = raw.match(/^    ([A-Za-z_][A-Za-z0-9_]*)(\?)?:\s*(.*)$/);
    if (!m) continue;
    cur = { name: m[1], optional: m[2] === '?' };
    buf = [m[3]];
    depth = countDepth(m[3]);
    if (depth === 0) flush();
  } else {
    buf.push(raw.trim());
    depth += countDepth(raw);
    if (depth <= 0) {
      depth = 0;
      flush();
    }
  }
}

function countDepth(s) {
  let d = 0;
  for (const ch of s) {
    if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d--;
  }
  return d;
}
function flush() {
  let t = buf.join(' ').replace(/\s+/g, ' ').trim();
  if (t.endsWith(';')) t = t.slice(0, -1);
  out.push({ name: cur.name, optional: cur.optional, type: t });
  cur = null;
  buf = [];
}

const pkg = JSON.parse(fs.readFileSync(SDK_PKG, 'utf8'));

// Read the query signature out of the declaration rather than restating it.
const qStart = lines.findIndex((l) => l.startsWith('export declare function query('));
if (qStart < 0) throw new Error('query declaration not found');
let qEnd = qStart;
while (qEnd < lines.length && !lines[qEnd].includes('): Query;')) qEnd++;
if (qEnd === lines.length) throw new Error('query declaration did not terminate');
const querySignature = lines
  .slice(qStart, qEnd + 1)
  .join(' ')
  .replace(/^export declare /, '')
  .replace(/\s+/g, ' ')
  .replace(/;$/, '')
  .trim();
const doc = {
  $comment:
    'Generated from the shipped sdk.d.ts of @anthropic-ai/claude-agent-sdk. Source of truth for tests/sdk-surface.test.ts (R-01).',
  package: pkg.name,
  version: pkg.version,
  claudeCodeVersion: pkg.claudeCodeVersion,
  retrieved: '2026-09-26',
  querySignature,
  optionCount: out.length,
  options: Object.fromEntries(
    out.map((o) => [o.name, { optional: o.optional, type: o.type }]),
  ),
};
fs.writeFileSync('options.json', JSON.stringify(doc, null, 2) + '\n');
console.log('count', out.length);
console.log(out.map((o) => o.name).join(' '));
