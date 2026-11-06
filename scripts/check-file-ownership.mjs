#!/usr/bin/env node
// File-ownership checker — the development plan §2.3, §9.1.
//
// Parallelism in this repository is bought with file ownership: two tasks may run
// concurrently only if their declared `Owns:` globs do not intersect. This script is the
// mechanical half of that rule. Zero dependencies, plain Node ESM (§40: a glob matcher is
// ~50 lines of clear code and does not justify a package).
//
//   node scripts/check-file-ownership.mjs --plan <wave-script.mjs> [...]
//       Parse the ownership declarations out of committed wave workflow scripts and fail if
//       two tasks at the same parallel level declare intersecting globs.
//
//   node scripts/check-file-ownership.mjs --pr [--base <ref>] [--head <ref>]
//       Read the PR body from $GITHUB_EVENT_PATH (or stdin), take the `Owns globs:` line from
//       its `## Ownership` section, and fail listing every changed file outside those globs.
//
//   node scripts/check-file-ownership.mjs --integration [--base <ref>] [--head <ref>]
//       The same, for a wave integration branch, where --pr cannot pass: its diff carries every
//       file the merged branches wrote. Reads the same PR body, and additionally one
//       `Merged <ref>: <globs>` line per merged branch. Each changed file is attributed to the
//       merge parent that introduced it, and must be inside THAT branch's declared globs; a file
//       no parent introduced must be inside the integrator's own `Owns globs:`. A file that is
//       neither FAILS — attribution is a positive rule, not an exemption for merges. See
//       docs/adr/W1-INT-02-the-ownership-gate-learns-about-merges.md.
//
//   node scripts/check-file-ownership.mjs --self-test
//       Run the built-in assertions for the glob matcher, the intersection detector, the
//       PR-body parser and the ownership enforcer. `.github/workflows/ci.yml` runs this as
//       its own step ("Ownership checker self-test") on every PR and every push, so a
//       regression here fails CI. It is not covered by `pnpm test`: vitest.config.ts sets
//       projects to 'apps/*' and 'packages/*' (with passWithNoTests, per
//       docs/adr/W0-INF-01-vitest-projects-follow-the-workspace.md — the record is now named
//       for its owning task, so the path is stable and is cited instead of the slug; the
//       number it used to carry belongs to ADR-0001, an unrelated decision), and
//       scripts/ matches neither, so it is not a Vitest project at all — and that file is
//       owned by W0-INF-01 (plan §6.2, W0-INF-01's Owns column), not by this task.
//
//   node scripts/check-file-ownership.mjs           (no arguments)
//       Equivalent to --plan over every script in .claude/workflows/.
//
// A wave script declares ownership in either of two shapes. An object literal:
//
//   export const ownership = {
//     Foundation: { 'W1-DB-01': ['migrations/**'] },
//     Implement:  { 'W1-RN-01': ['apps/runner/**'], 'W1-UI-01': ['apps/web/app/**'] },
//   }
//
// or line comments, whose level is the nearest preceding phase() call:
//
//   phase('Implement')
//   // Owns W1-RN-01: apps/runner/**, packages/core/src/runner/**

/* global console, process */ // The root ESLint config declares no environment globals.

import { readFileSync, realpathSync } from 'node:fs';

import path from 'node:path';
import { selfTest } from './ownership/self-test.mjs';
import { prMode } from './ownership/pull-request.mjs';
import { planMode } from './ownership/plans.mjs';
export {
  expandBraces,
  normalizeGlob,
  matchGlob,
  matchAny,
  literalPrefix,
  literalPrefixOverlap,
  globsIntersect,
  findViolations,
} from './ownership/globs.mjs';
export { parsePlan } from './ownership/plans.mjs';
export {
  stripCodeBlocks,
  areasFromTree,
  trackedAreaNames,
  ownsEverything,
  parseOwnership,
  parseIntegrationOwnership,
  findIntegrationViolations,
} from './ownership/body.mjs';

// ── Entry point ─────────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    // The header block, from the line after the shebang up to the `/* global */` pragma that
    // ends it — found by that landmark rather than by a line number. A hardcoded `slice(1, 30)`
    // was here, and adding a mode to the header silently truncated the help text mid-sentence:
    // the usage text is derived from the file, so its extent must be too.
    const lines = readFileSync(import.meta.filename, 'utf8').split('\n');
    const end = lines.findIndex((l) => l.startsWith('/* global'));
    if (end === -1) {
      console.error(
        'This file no longer carries the "/* global" line that ends its header block, so --help ' +
          'cannot tell where the usage text stops. Restore it, or teach main() the new landmark.',
      );
      return 1;
    }
    console.log(
      lines
        .slice(1, end)
        .join('\n')
        .replace(/^\/\/ ?/gm, '')
        .trimEnd(),
    );
    return 0;
  }
  if (args.includes('--self-test')) return selfTest();
  if (args.includes('--pr') || args.includes('--integration')) return prMode(args);
  return planMode(args.filter((a) => a !== '--plan'));
}

// Only exit when run as a program. Importing this module (from a test, or from another
// script) must not terminate the host process — the exported functions above are the API.
// Compared through realpathSync, not path.resolve alone: `import.meta.filename` is already
// symlink-resolved, so on a checkout reached through a symlinked path the two spellings differ,
// main() never runs and the process exits 0 — a gate that passes by doing nothing. Falls back
// to the plain resolve when a path cannot be realpath'd.
const samePath = (a, b) => {
  const real = (p) => {
    try {
      return realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};

const invokedDirectly = Boolean(process.argv[1]) && samePath(process.argv[1], import.meta.filename);

if (invokedDirectly) process.exit(main(process.argv));
