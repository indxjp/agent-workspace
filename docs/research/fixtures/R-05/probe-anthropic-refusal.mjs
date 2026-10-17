// R-05 probe: does the Anthropic Messages API have a stop reason for content blocked
// by a platform safety filter? R-05 round 1 asserted it does not. Read the shipped
// type definitions of the installed SDK.
import { readFileSync } from 'node:fs';
const base = 'node_modules/@anthropic-ai/sdk';
console.log('@anthropic-ai/sdk version:', JSON.parse(readFileSync(`${base}/package.json`,'utf8')).version);
const d = readFileSync(`${base}/resources/messages/messages.d.ts`, 'utf8');
const lines = d.split(/\r?\n/);
const show = (re, label) => {
  console.log(`\n--- ${label} ---`);
  lines.forEach((l, i) => { if (re.test(l)) console.log(String(i + 1).padStart(5) + ': ' + l.trim()); });
};
show(/^\s*export (type|interface) StopReason/, 'StopReason declaration line');
const i = lines.findIndex(l => /^\s*export type StopReason/.test(l));
console.log('\n--- StopReason union, verbatim ---');
console.log(lines.slice(i, i + 4).join('\n'));
const j = lines.findIndex(l => /interface RefusalStopDetails/.test(l));
console.log('\n--- RefusalStopDetails, verbatim (declaration + body) ---');
console.log(lines.slice(j, j + 40).join('\n'));
console.log('\n--- occurrences of the literal "refusal" in messages.d.ts ---');
console.log((d.match(/'refusal'/g) || []).length, "single-quoted 'refusal' tokens");
