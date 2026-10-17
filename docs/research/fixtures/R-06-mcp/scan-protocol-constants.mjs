// R-06 probe — what MCP protocol version do the shipped Agent SDK artefacts declare?
//
// §6 grades that `verified`, and the reading it rests on used to come from a scan for the literal
// `"2025-11-25"`. A scan for the answer can corroborate the answer and can never contradict it: a
// build that declared a different latest version would produce an empty result, which reads as
// "nothing found" rather than as "the note is wrong". ADR-0027 — a rule that selects a set must be
// a classifier that ends in rejection, not a filter that keeps what it was looking for.
//
// So this derives instead, in two steps, and the second one is where the rejection lives.
//
// 1. CANDIDATE. An array literal that contains no nested array literal and at least one of whose
//    own top-level members is an ISO-date string. That is the whole admission rule. It is stated
//    here rather than left to be inferred, because it is also this scan's coverage limit — see
//    "What escapes it" below.
//
// 2. CLASSIFY. Every member of a candidate must resolve to an ISO date: as a `"YYYY-MM-DD"`
//    literal, or as an identifier the file binds to one in a `var`/`let`/`const` declaration —
//    including the comma-continued binders a minified bundle emits (`var A="…",B="…"`), which the
//    win32 binary uses for the newest of these lists. A candidate holding a member that does not
//    resolve is named on stdout and the process exits 3. It is not skipped, and it is not counted
//    as a version list. An identifier bound to two different dates in the same file resolves to
//    neither, so a list headed by it is rejected rather than guessed.
//
// The version an artefact speaks is then the head of the lists derived from it, read out rather
// than assumed, and a disagreement between two bundled copies shows up as two distinct heads.
//
// What escapes it, stated so a reader does not have to infer the gap from the code: an array
// literal none of whose members is a `"YYYY-MM-DD"` literal — every member an identifier, as in
// `var A="2026-07-28",L=[A]` — is not a candidate, so it never reaches the rejection in step 2 and
// nothing about it appears in the output. That shape is in the win32 binary today
// (`var Js="2026-07-28",Xr=[Js]`). An array literal wrapping a nested array literal is likewise not
// a candidate, though the nested array inside it still is. The note's §6 carries both as declared
// gaps rather than claiming the derivation is exhaustive.
//
// Usage:
//   node scan-protocol-constants.mjs <path>...
// Each path is a file or a directory. A directory is walked recursively and every regular file
// under it is read, so pointing this at an installed package directory derives the artefact set by
// shape instead of naming the files someone already believed were the interesting ones. `.exe` is
// read as latin1 — it is a binary that embeds the same JavaScript, and latin1 is the encoding that
// maps every byte to one character; every other file is read as utf8.
import fs from 'node:fs';
import path from 'node:path';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_STRING = /^"(\d{4}-\d{2}-\d{2})"$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** A binder in a declaration statement: the keyword form, and the comma-continued form after it. */
const DATE_BINDING =
  /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*"(\d{4}-\d{2}-\d{2})"|,\s*([A-Za-z_$][\w$]*)\s*=\s*"(\d{4}-\d{2}-\d{2})"/g;
/** An array literal holding no nested array literal. */
const ARRAY_LITERAL = /\[[^\[\]]*\]/g;

/** Split an array literal's interior at its own commas, stepping over strings, braces and parens. */
function splitMembers(inner) {
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote !== null) {
      current += c;
      if (c === '\\') {
        current += inner[i + 1] ?? '';
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      current += c;
      continue;
    }
    if (c === '{' || c === '(') {
      depth += 1;
      current += c;
      continue;
    }
    if (c === '}' || c === ')') {
      depth -= 1;
      current += c;
      continue;
    }
    if (c === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current.trim());
  return out;
}

/** Every regular file at or under `target`, sorted, so walk order does not depend on the OS. */
function filesUnder(target) {
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs
    .readdirSync(target, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath ?? d.path, d.name))
    .sort();
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scan-protocol-constants.mjs <file-or-directory>...');
  process.exit(2);
}

let rejected = 0;
let filesRead = 0;
const allHeads = new Set();

for (const target of targets) {
  for (const file of filesUnder(target)) {
    filesRead += 1;
    const encoding = file.toLowerCase().endsWith('.exe') ? 'latin1' : 'utf8';
    const text = fs.readFileSync(file, encoding);

    const bound = new Map();
    const ambiguous = new Set();
    for (const m of text.matchAll(DATE_BINDING)) {
      const name = m[1] ?? m[3];
      const date = m[2] ?? m[4];
      if (bound.has(name) && bound.get(name) !== date) ambiguous.add(name);
      bound.set(name, date);
    }
    const resolve = (token) => {
      const literal = DATE_STRING.exec(token);
      if (literal !== null) return literal[1];
      if (!IDENTIFIER.test(token)) return null;
      if (ambiguous.has(token)) return null;
      return bound.get(token) ?? null;
    };

    const lists = [];
    const rejects = [];
    for (const m of text.matchAll(ARRAY_LITERAL)) {
      const members = splitMembers(m[0].slice(1, -1));
      if (!members.some((t) => DATE_STRING.test(t))) continue;
      const resolved = members.map(resolve);
      const unresolved = members.filter(
        (_, i) => resolved[i] === null || !ISO_DATE.test(resolved[i]),
      );
      if (unresolved.length > 0) {
        rejects.push({ source: m[0], unresolved });
        continue;
      }
      lists.push({ source: m[0], members: resolved });
    }
    if (lists.length === 0 && rejects.length === 0) continue;

    console.log(`\n== ${path.basename(file)} (${encoding}) ==`);
    for (const r of rejects) {
      console.log(
        `  REJECT — member(s) ${JSON.stringify(r.unresolved)} of an array holding an ISO date do not resolve to ISO dates: ${r.source.slice(0, 90)}`,
      );
      rejected += 1;
    }
    for (const l of lists) {
      console.log(`  ${l.source.slice(0, 70)}  ->  ${JSON.stringify(l.members)}`);
    }
    const heads = [...new Set(lists.map((l) => l.members[0]))];
    for (const h of heads) allHeads.add(h);
    console.log(`  distinct heads across the lists derived from this file: ${JSON.stringify(heads)}`);
  }
}

console.log(`\nfiles read: ${filesRead}`);
console.log(`distinct heads across every derived list: ${JSON.stringify([...allHeads].sort())}`);

// ADR-0015: a check that could not run must fail. An unclassifiable list is not a version list and
// is not nothing either — it is a reading this scan could not take, so the scan reports failure.
if (rejected > 0) {
  console.log(
    `\nFAIL: ${rejected} array(s) holding an ISO date could not be classified; the derived set above is incomplete.`,
  );
  process.exit(3);
}
