#!/usr/bin/env node
// The bin of `npm create @indx-workspace <directory>`; see `run.ts`.
import { nodeTooOld, windowsNodeInWsl } from './engines.js';

const refusal =
  nodeTooOld(process.versions.node) ??
  windowsNodeInWsl(process.platform, process.cwd(), process.env['INIT_CWD']);
if (refusal === null) {
  // Loaded only now: on a Node below the engines the generator's own imports may not link.
  const { runCreate } = await import('./run.js');
  process.exitCode = await runCreate(process.argv.slice(2));
} else {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = 1;
}
