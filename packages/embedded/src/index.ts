#!/usr/bin/env node
/**
 * `agent-workspace-embedded` — the development-only embedded workspace of a repository clone,
 * run as `pnpm start:embedded` from the repository root. See `workspace.ts` for why it is not a
 * verb of the published `agent-workspace` binary.
 */
import { runAsProcess } from '@indx-workspace/cli';

import { runEmbeddedCommand } from './workspace.js';

process.exitCode = await runAsProcess(() => runEmbeddedCommand());
