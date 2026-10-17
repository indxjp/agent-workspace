#!/usr/bin/env node
/**
 * `pnpm formal:check` — every gate over the Lean specification (docs/adr/0062), in order of
 * cost: build, the soundness audit (`lake exe axioms`: no `sorry`, no axiom beyond `propext`,
 * `Classical.choice`, `Quot.sound`, every public theorem traced and tiered), the layer direction
 * (`lake exe imports`), and the generated catalogue, traceability matrix and vectors being
 * current (`generate.mjs --check`).
 */
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { REPOSITORY_ROOT, runLake } from './lake.mjs';

try {
  runLake(['build', 'AgentWorkspace', 'catalogue', 'axioms', 'imports', 'vectors']);
  runLake(['exe', 'axioms']);
  runLake(['exe', 'imports']);
  const generate = spawnSync(
    process.execPath,
    [path.join(REPOSITORY_ROOT, 'scripts', 'formal', 'generate.mjs'), '--check'],
    { stdio: 'inherit' },
  );
  if (generate.status !== 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
