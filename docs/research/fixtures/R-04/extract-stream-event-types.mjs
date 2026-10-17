// R-04 probe — generate, never transcribe, the `ResponseStreamEvent` discriminant list.
//
// ADR-0016: a list in a research note is generated. Round 1 of this note transcribed the union by
// hand and shipped eleven type strings that do not exist in the SDK, plus a member count of 56
// against an actual 58. This script is the replacement: it reads the shipped type declarations of
// an installed `openai` package off disk and prints every `type:` literal the union can carry.
//
// It reads files. It does not `import` the `openai` package — deliberately, so that this file
// stays inside the §42 boundary gate's existing verdict (`tests/no-sdk-import.test.ts`,
// ADR-0032 clause 1: a committed fixture that imports an undeclared package must be named in
// that test's literal, which is outside this note's owns globs). `node:fs`/`node:path` only.
//
//   npm install openai@7.10.0
//   node extract-stream-event-types.mjs ./node_modules/openai
//
// Output is deterministic: nothing here reads the clock, the network, or the environment.
import fs from 'node:fs';
import path from 'node:path';

const pkgRoot = path.resolve(process.argv[2] ?? './node_modules/openai');
const dts = path.join(pkgRoot, 'resources', 'responses', 'responses.d.ts');
const version = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
const source = fs.readFileSync(dts, 'utf8');
const lines = source.split(/\r?\n/);

// 1. The union declaration itself, located by name rather than by line number, so the script
//    survives a version bump instead of silently reading the wrong line.
const unionLineIndex = lines.findIndex((l) => l.startsWith('export type ResponseStreamEvent = '));
if (unionLineIndex < 0) throw new Error(`no 'export type ResponseStreamEvent =' in ${dts}`);
const unionText = lines[unionLineIndex].replace(/^export type ResponseStreamEvent = /, '').replace(/;\s*$/, '');
const members = unionText.split('|').map((s) => s.trim()).filter(Boolean);

// 2. Each member is an interface in this same file; its discriminant is the `type:` property at
//    the interface's own top level (indent 4), never one inside a nested `declare namespace`.
function discriminantOf(interfaceName) {
  const open = lines.findIndex((l) => l === `export interface ${interfaceName} {`);
  if (open < 0) return { interfaceName, error: 'interface declaration not found' };
  const found = [];
  for (let i = open + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') break; // top-level close: this file emits it in column 0
    const m = /^ {4}type: '([^']+)';$/.exec(lines[i]);
    if (m) found.push(m[1]);
  }
  if (found.length !== 1) return { interfaceName, error: `expected 1 discriminant, found ${found.length}` };
  return { interfaceName, type: found[0] };
}

const resolved = members.map(discriminantOf);
const failures = resolved.filter((r) => r.error);
const types = resolved.filter((r) => r.type).map((r) => r.type);
const duplicates = types.filter((t, i) => types.indexOf(t) !== i);

console.log(`openai package version: ${version}`);
console.log(`source: resources/responses/responses.d.ts line ${unionLineIndex + 1}`);
console.log(`union members: ${members.length}`);
console.log(`resolved discriminants: ${types.length}`);
console.log(`duplicates: ${duplicates.length ? duplicates.join(', ') : '(none)'}`);
console.log(`unresolved: ${failures.length ? failures.map((f) => `${f.interfaceName} (${f.error})`).join(', ') : '(none)'}`);
console.log('');
console.log('--- every `type` value ResponseStreamEvent can carry, sorted ---');
for (const t of [...types].sort()) console.log(t);
console.log('');
console.log('--- the same values in union-declaration order, with the interface each comes from ---');
for (const r of resolved) console.log(`${r.type ?? `!! ${r.error}`}\t${r.interfaceName}`);
if (failures.length) process.exitCode = 1;
