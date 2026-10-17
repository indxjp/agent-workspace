// R-04 probe — generate, never transcribe, the OpenAI-vs-Anthropic SDK exception-class comparison.
//
// ADR-0016 again. Round 1 of this note asserted "identical set to R-03's Anthropic-SDK list except
// this one adds `UnprocessableEntityError` (422)"; R-03's list already contained
// `UnprocessableEntityError`, and the five classes that genuinely are OpenAI-only were missed.
// A hand-written set difference is exactly the artefact that should be computed.
//
// Reads the two shipped `core/error.d.ts` files off disk. It imports neither package, for the
// same §42 boundary-gate reason as `extract-stream-event-types.mjs`.
//
//   npm install openai@7.10.0 @anthropic-ai/sdk@0.123.0
//   node extract-error-classes.mjs ./node_modules/openai ./node_modules/@anthropic-ai/sdk
import fs from 'node:fs';
import path from 'node:path';

const roots = [process.argv[2] ?? './node_modules/openai', process.argv[3] ?? './node_modules/@anthropic-ai/sdk'];

function classesOf(root) {
  const pkgRoot = path.resolve(root);
  const name = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  const file = path.join(pkgRoot, 'core', 'error.d.ts');
  const source = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const l of source.split(/\r?\n/)) {
    // `export declare class X extends Y` / `... extends APIError<400, Headers>`; the base is kept
    // because "which HTTP status does this class mean" is the whole reason the list is here.
    const m = /^export declare class (\w+) extends ([^{]+?)\s*\{/.exec(l);
    if (m) found.push({ cls: m[1], base: m[2] });
  }
  return { pkg: `${name.name}@${name.version}`, file: path.relative(pkgRoot, file).replace(/\\/g, '/'), found };
}

const [a, b] = roots.map(classesOf);
const names = (x) => new Set(x.found.map((e) => e.cls));
const [an, bn] = [names(a), names(b)];

const table = (x) => x.found.map((e) => `  ${e.cls.padEnd(30)} extends ${e.base}`).join('\n');
console.log(`A = ${a.pkg}  (${a.file}, ${a.found.length} classes)`);
console.log(table(a));
console.log('');
console.log(`B = ${b.pkg}  (${b.file}, ${b.found.length} classes)`);
console.log(table(b));
console.log('');
console.log(`in BOTH (${[...an].filter((n) => bn.has(n)).length}): ${[...an].filter((n) => bn.has(n)).sort().join(', ')}`);
console.log(`only in A (${[...an].filter((n) => !bn.has(n)).length}): ${[...an].filter((n) => !bn.has(n)).sort().join(', ') || '(none)'}`);
console.log(`only in B (${[...bn].filter((n) => !an.has(n)).length}): ${[...bn].filter((n) => !an.has(n)).sort().join(', ') || '(none)'}`);
