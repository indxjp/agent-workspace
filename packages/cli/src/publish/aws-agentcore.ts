/**
 * AgentCore (agent platform), published with the vendor's own `agentcore` CLI
 * (https://github.com/aws/agentcore-cli/blob/main/docs/commands.md, read 2026-10-10). This is not
 * the `aws-agentcore` runtime driver (`packages/contracts/src/runtimes.ts`): the executor publishes
 * an agent definition and never starts a sandbox.
 *
 * AWS credentials and region come from the user's own profile or environment: nothing here passes a
 * credential. The CLI reads `agentcore/agentcore.json` and `agentcore/aws-targets.json`; a different
 * layout fails at `agentcore validate`, which is fixed in the translator, not rewritten here.
 *
 * VERIFY: the `deploy --dry-run --json` shape is inferred (`changes` as a list, or a boolean) and is
 * pinned by `fixtures/agentcore-dry-run-*.json`; anything this parser does not recognise counts as a
 * change, so drift fails safe. Replace the fixtures with captured output:
 * https://github.com/aws/agentcore-cli/blob/main/docs/commands.md
 */
import { z } from 'zod';

import {
  defineExecutor,
  requireTool,
  runPublishTool,
  type PublishOutcome,
  type PublishTool,
} from './kit.ts';

const AGENTCORE_TOOL: PublishTool = {
  name: 'agentcore',
  versionArgs: ['--version'],
  // https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-get-started.html
  install: 'npm install -g @aws/agentcore',
  docsUrl: 'https://github.com/aws/agentcore-cli/blob/main/docs/commands.md',
};

const DryRunSchema = z.looseObject({
  changes: z.union([z.boolean(), z.array(z.unknown())]),
});

/** Whether the dry-run JSON reports a change; anything unrecognised is a change. */
export function dryRunHasChanges(output: string): boolean {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    return true;
  }
  const parsed = DryRunSchema.safeParse(json);
  if (!parsed.success) return true;
  return typeof parsed.data.changes === 'boolean'
    ? parsed.data.changes
    : parsed.data.changes.length > 0;
}

export const awsAgentcore = defineExecutor({
  tools: [AGENTCORE_TOOL],
  defaultEnvironment: 'default',
  // Compile keys (`region`, `accountId`, …) share the merged settings and were validated when the
  // bundle was exported; `agentcore` takes no setting, so unknown keys are stripped, not refused.
  settingsSchema: z.object({}),
  async publish(context): Promise<PublishOutcome> {
    const target = context.environment;
    await requireTool(context, AGENTCORE_TOOL);

    await runPublishTool(context, AGENTCORE_TOOL, ['validate', '-d', '.']);
    const plan = await runPublishTool(context, AGENTCORE_TOOL, [
      'deploy',
      '--target',
      target,
      '--dry-run',
      '--json',
    ]);
    const changes = dryRunHasChanges(plan.stdout);
    if (!context.apply || !changes) {
      return { changes, applied: false, nextSteps: [] };
    }

    await runPublishTool(context, AGENTCORE_TOOL, ['deploy', '--target', target, '-y', '--json']);
    return {
      changes,
      applied: true,
      nextSteps: [`agentcore status --target ${target} --json`],
    };
  },
});
