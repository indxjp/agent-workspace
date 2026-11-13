import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from '../journey/run.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CLAIMS_IN = `${HOME}/claims`;

export const COMPILE_IN = `${HOME}/compile`;

const PREFIX_IN = `${HOME}/.npm-global`;

export const SHELL_SETUP = `export PATH="${PREFIX_IN}/bin:$PATH" NPM_CONFIG_PREFIX="${PREFIX_IN}"; `;

export const COMMAND_VARIABLE = 'DOCS_CLAIMS_COMMAND_TIMEOUT_MS';

export const COMMAND_TIMEOUT_MS = 5 * 60_000;

export const DEV_READY_MS = 3 * 60_000;

export const DEV_COMMAND = 'npm run dev';

export const NEEDS_KEY = 'skipped: needs ANTHROPIC_API_KEY (not configured)';

export const STACK_BUILDER = 'sites/lp/assets/site.js';

export const CLI_PAGE = 'docs/sdk/site/cli/overview.mdx';

export const QUICKSTART_PAGE = 'docs/sdk/site/getting-started/quickstart.mdx';

export const FIRST_HOUR_OWNS = 'owned by journey-e2e first-hour (T1-T3 run these commands)';

export const MAX_WHAT = 90;

export const MAX_DETAIL_LINES = 40;
