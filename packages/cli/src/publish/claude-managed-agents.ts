/**
 * Claude Managed Agents, published with the vendor's own `ant apply`
 * (https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply, read 2026-10-10).
 *
 * `ant` keeps its login (profile, `ANTHROPIC_API_KEY` or workload identity) to itself: nothing here
 * passes a credential. `--force`, `--prune` and `--upgrade` are never passed, so a resource edited
 * outside the exported files blocks the publish instead of being overwritten.
 *
 * VERIFY: the plan text parsed below comes from the documented output and is pinned by
 * `fixtures/ant-dry-run-*.txt`. Only the create plan and the `This plan cannot be applied:` line
 * are shown by the docs; the update and unchanged texts are inferred and anything this parser does
 * not recognise counts as a change, so drift fails safe. Replace the fixtures with captured output.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  defineExecutor,
  requireTool,
  runPublishTool,
  type PublishOutcome,
  type PublishTool,
} from './kit.ts';

const VAULT_MINIMUM_VERSION = '1.34.0';
const BLOCKED_MARKER = 'This plan cannot be applied:';
const CLAUDE_LOCK_FILE = 'claude-lock.json';

const ANT_TOOL: PublishTool = {
  name: 'ant',
  versionArgs: ['--version'],
  minimumVersion: '1.30.0',
  // https://platform.claude.com/docs/en/cli-sdks-libraries/cli/quickstart
  install:
    'brew install anthropics/tap/ant (macOS) or go install github.com/anthropics/anthropic-cli/cmd/ant@latest',
  docsUrl: 'https://platform.claude.com/docs/en/cli-sdks-libraries/cli/apply',
};

const LockFileSchema = z.object({
  version: z.literal(1),
  // Keyed by the source file (`./agents/<file>.md`); the entry's other fields are not pinned yet.
  resources: z.record(z.string(), z.object({ id: z.string() })),
});

/** Whether the plan's `Resources  …` summary line says anything will be created, updated or removed. */
export function planHasChanges(plan: string): boolean {
  const summary = /^Resources[ \t]+(.+)$/mu.exec(plan)?.[1];
  if (summary === undefined) return true;
  if (/\b[1-9]\d*\s+to\s+[a-z]+/iu.test(summary)) return true;
  return !/\bunchanged\b|\bno changes\b/iu.test(summary);
}

async function hasVaults(directory: string): Promise<boolean> {
  const found = await stat(path.join(directory, 'vaults')).catch(() => null);
  return found?.isDirectory() === true;
}

/** The agent ids `ant apply` recorded, or a next step when the lock file cannot be read. */
async function lockSteps(directory: string): Promise<readonly string[]> {
  const file = path.join(directory, CLAUDE_LOCK_FILE);
  try {
    const lock = LockFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    return Object.entries(lock.resources)
      .filter(([key]) => key.startsWith('./agents/'))
      .map(([, resource]) => `agent id: ${resource.id}`);
  } catch (error) {
    return [
      `read ${CLAUDE_LOCK_FILE} yourself: ant applied, but the file could not be read (${error instanceof Error ? error.name : 'unknown error'})`,
    ];
  }
}

export const claudeManagedAgents = defineExecutor({
  tools: [ANT_TOOL],
  defaultEnvironment: 'default',
  // Compile keys (`model`, `allowedHosts`, …) share the merged settings and were validated when the
  // bundle was exported; `ant` takes no setting, so unknown keys are stripped, not refused.
  settingsSchema: z.object({}),
  async publish(context): Promise<PublishOutcome> {
    const floor = (await hasVaults(context.directory))
      ? VAULT_MINIMUM_VERSION
      : ANT_TOOL.minimumVersion;
    await requireTool(context, ANT_TOOL, floor);

    const plan = await runPublishTool(context, ANT_TOOL, ['apply', '--dry-run', '.']);
    if (`${plan.stdout}\n${plan.stderr}`.includes(BLOCKED_MARKER)) {
      throw new Error(
        'ant apply refused the plan: a resource was changed outside these files; resolve it in the Claude Console, then publish again',
      );
    }
    const changes = planHasChanges(plan.stdout);
    if (!context.apply || !changes) {
      return { changes, applied: false, nextSteps: [] };
    }

    await runPublishTool(context, ANT_TOOL, ['apply', '--yes', '.']);
    return {
      changes,
      applied: true,
      nextSteps: [
        ...(await lockSteps(context.directory)),
        `commit ${path.join(context.directory, CLAUDE_LOCK_FILE).split(path.sep).join('/')} with the exported files`,
      ],
    };
  },
});
