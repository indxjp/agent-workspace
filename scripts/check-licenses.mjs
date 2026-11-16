#!/usr/bin/env node
// Classify installed dependencies against the SPDX policy. Any denied or unreviewed package fails.
// Usage: node scripts/check-licenses.mjs [--dev | --engine <id> | --self-test]
// Policy decisions and exception requirements: docs/dependency-policy.md.

import console from 'node:console';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateInventory } from './licenses/inventory.mjs';
import { selfTest } from './licenses/self-test.mjs';
export { POLICY, EXCEPTIONS } from './licenses/policy.mjs';
export {
  parseSpdx,
  DEPRECATED_SPDX_WITH_FORMS,
  canonicaliseSpdx,
  canonicalLicence,
  expressionSatisfies,
  expressionDenied,
  salvageDenied,
} from './licenses/spdx.mjs';
export {
  makePolicy,
  classify,
  matchName,
  matchException,
  evaluateInventory,
} from './licenses/inventory.mjs';

function renderTable(rows) {
  const header = ['VERDICT', 'PACKAGE', 'LICENCE', 'WHY'];
  const body = rows.map((r) => [
    r.verdict.toUpperCase(),
    `${r.name}@${r.version}`,
    r.licence,
    r.why,
  ]);
  const widths = header.map((h, i) =>
    Math.min(60, Math.max(h.length, ...body.map((row) => row[i].length))),
  );
  const line = (cells) =>
    '  ' + cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  return [line(header), line(widths.map((w) => '─'.repeat(w))), ...body.map(line)].join('\n');
}

// ── Modes ───────────────────────────────────────────────────────────────────────────────

/** An engine id as `ENGINE_IDS` spells one; the only input this script interpolates. */
const ENGINE_ID = /^[a-z][a-z0-9-]*$/u;

function readInventory(scope, engine) {
  const command =
    engine === undefined
      ? `pnpm licenses list ${scope === 'dev' ? '--dev' : '--prod'} --json -r`
      : `pnpm --filter "@agent-workspace/runner..." --filter "@agent-workspace/engine-${engine}..." licenses list --prod --json`;
  let raw;
  try {
    raw = execSync(command, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    console.error(`\nLicence policy: FAIL — \`${command}\` did not run.`);
    console.error(
      'Run `pnpm install --frozen-lockfile` first; the gate inspects the installed tree.',
    );
    return null;
  }
  // `pnpm licenses list` exits 0 whatever it finds — it is an inventory command, not a gate.
  // The gate is this script's exit code. An empty tree prints nothing at all.
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    console.error(`\nLicence policy: FAIL — could not parse the output of \`${command}\`.`);
    return null;
  }
}

function gateMode(scope, engine) {
  const inventory = readInventory(scope, engine);
  if (inventory === null) return 1;
  const rows = evaluateInventory(inventory, { scope });
  const denied = rows.filter((r) => r.verdict === 'deny');
  const review = rows.filter((r) => r.verdict === 'review');

  if (rows.length) {
    console.error(`\nLicence policy (${scope}) — packages that are not on the allow list:\n`);
    console.error(renderTable(rows));
    console.error('');
    if (denied.length) {
      console.error(
        'DENY cannot be cleared by an exception. Remove the dependency, or change the policy in',
      );
      console.error('scripts/licenses/policy.mjs with an ADR saying why.');
    }
    if (review.length) {
      console.error('REVIEW needs a recorded exception in scripts/licenses/policy.mjs,');
      console.error('with a reviewer, a reason, the exact licence string, and an expiry.');
    }
    console.error(
      `\nLicence policy: FAIL (${denied.length} denied, ${review.length} to review) [${scope}].`,
    );
    console.error('See docs/dependency-policy.md.');
    return 1;
  }
  console.log(`Licence policy: PASS (${scope}).`);
  return 0;
}

export function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    // The header block: every line after the shebang, up to the first that is not a `//`
    // comment. This used to be a hardcoded `.slice(1, 31)`, which silently started printing
    // the wrong thing the moment anyone added a line to the header — as this commit does.
    const lines = readFileSync(import.meta.filename, 'utf8')
      .split('\n')
      .slice(1);
    const end = lines.findIndex((line) => !line.startsWith('//'));
    const header = lines.slice(0, end === -1 ? lines.length : end);
    console.log(
      header
        .join('\n')
        .replace(/^\/\/ ?/gm, '')
        .trimEnd(),
    );
    return 0;
  }
  if (args.includes('--self-test')) return selfTest();
  const engineAt = args.indexOf('--engine');
  if (engineAt !== -1) {
    const engine = args[engineAt + 1];
    if (engine === undefined || !ENGINE_ID.test(engine)) {
      console.error('usage: check-licenses.mjs --engine <engine id matching ^[a-z][a-z0-9-]*$>');
      return 2;
    }
    return gateMode('prod', engine);
  }
  return gateMode(args.includes('--dev') ? 'dev' : 'prod');
}

// Only exit when run as a program. Importing this module (from a test, or from another script)
// must not terminate the host process — the exported functions above are the API.
const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invokedDirectly) process.exit(main(process.argv));
