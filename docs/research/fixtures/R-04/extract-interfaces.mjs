#!/usr/bin/env node
// R-04 fixture generator — print named TypeScript declarations VERBATIM out of an installed
// `openai` package, with their real line numbers.
//
//   node extract-interfaces.mjs <path-to-node_modules/openai> [specifier ...]
//
// A specifier is a dotted path: `FunctionTool`, `ResponseInputItem.FunctionCallOutput`. With no
// specifiers the script prints the default set the note quotes. Three different interfaces in
// `resources/responses/responses.d.ts` are called `FunctionCallOutput`, which is exactly why the
// path is dotted and why matching on the bare name would be wrong.
//
// Why this exists: round 1 of R-04 hand-transcribed these blocks and round 2 left them alone.
// The transcriptions renamed three declared types and silently dropped six declared fields.
// ADR-0016 clause 2 — a list derived from the tree is generated, carries BEGIN/END GENERATED
// markers, and ships the command that produced it. Imports nothing but `node:fs`/`node:path`.
import fs from 'node:fs';
import path from 'node:path';

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: extract-interfaces.mjs <path-to-node_modules/openai> [specifier ...]');
  process.exit(2);
}
const DEFAULTS = [
  'FunctionTool',
  'ResponseInputItem.FunctionCallOutput',
  'ResponseFunctionCallOutputItem',
  'ResponseFunctionCallOutputItemList',
];
const wanted = process.argv.length > 3 ? process.argv.slice(3) : DEFAULTS;

const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
const rel = 'resources/responses/responses.d.ts';
const lines = fs.readFileSync(path.join(pkgDir, rel), 'utf8').split('\n');

/** Line index of the `}` that closes the block opened on line `open`. */
function matchingClose(open) {
  let depth = 0;
  for (let j = open; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) return j;
  }
  return lines.length - 1;
}

// Single forward pass. `openNs` is the stack of enclosing namespaces, so a declaration is
// identified by where it sits rather than by its bare name.
const found = new Map();
const openNs = [];
const NS = /^(?:export\s+)?(?:declare\s+)?namespace\s+([A-Za-z0-9_$]+)\s*\{/;
const IFACE = /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\{/;
const ALIAS = /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*=/;

for (let i = 0; i < lines.length; i++) {
  while (openNs.length && openNs[openNs.length - 1].close < i) openNs.pop();
  const text = lines[i].trim();
  const prefix = openNs.map((n) => n.name);

  const ns = NS.exec(text);
  if (ns) {
    openNs.push({ name: ns[1], close: matchingClose(i) });
    continue;
  }
  const iface = IFACE.exec(text);
  if (iface) {
    const close = matchingClose(i);
    const dotted = [...prefix, iface[1]].join('.');
    if (!found.has(dotted)) found.set(dotted, { start: i, end: close });
    i = close;
    continue;
  }
  const alias = ALIAS.exec(text);
  if (alias) {
    let end = i;
    while (end < lines.length && !/;\s*$/.test(lines[end])) end++;
    const dotted = [...prefix, alias[1]].join('.');
    if (!found.has(dotted)) found.set(dotted, { start: i, end });
    i = end;
  }
}

console.log(`openai package version: ${version}`);
console.log(`source: ${rel}`);
console.log(`declarations requested: ${wanted.length}`);
const missing = wanted.filter((w) => !found.has(w));
console.log(`unresolved: ${missing.length ? missing.join(', ') : '(none)'}`);
if (missing.length) process.exitCode = 1;

for (const w of wanted) {
  const hit = found.get(w);
  console.log('');
  if (!hit) {
    console.log(`--- ${w} — NOT FOUND ---`);
    continue;
  }
  console.log(`--- ${w} — ${rel} L${hit.start + 1}-${hit.end + 1}, verbatim ---`);
  for (let j = hit.start; j <= hit.end; j++) console.log(lines[j].replace(/\s+$/, ''));
}
