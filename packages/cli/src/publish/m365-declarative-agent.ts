/**
 * Microsoft 365 Copilot declarative agents, published with the Microsoft 365 Agents Toolkit CLI
 * (https://learn.microsoft.com/microsoftteams/platform/toolkit/microsoft-365-agents-toolkit-cli,
 * read 2026-10-10). `-i false` is its global non-interactive switch.
 *
 * The Toolkit has no diff, so the plan is local (`validate`, `package`) and always reports a
 * change. `atk provision` runs the `provision:` stage the exported `m365agents.yml` declares:
 * `teamsApp/create`, `zipAppPackage`, `validateAppPackage`, `teamsApp/update`, `copilotAgent/publish`
 * (pinned by the P4 golden `m365-declarative-agent/__golden__/full/expected/m365agents.yml`), which
 * registers the agent and side-loads it for the signed-in account. `atk publish`, which submits it
 * to the organization catalog for admin approval, is a next step and never run here.
 */
import { z } from 'zod';

import {
  defineExecutor,
  requireTool,
  runPublishTool,
  type PublishOutcome,
  type PublishTool,
} from './kit.ts';

const ATK_TOOL: PublishTool = {
  name: 'atk',
  versionArgs: ['--version'],
  install: 'npm install -g @microsoft/m365agentstoolkit-cli',
  docsUrl:
    'https://learn.microsoft.com/microsoftteams/platform/toolkit/microsoft-365-agents-toolkit-cli',
};

export const m365DeclarativeAgent = defineExecutor({
  tools: [ATK_TOOL],
  defaultEnvironment: 'dev',
  // Compile keys share the merged settings and were validated at export; `atk` takes none.
  settingsSchema: z.object({}),
  async publish(context): Promise<PublishOutcome> {
    const flags = ['--env', context.environment, '--folder', '.', '-i', 'false'];
    await requireTool(context, ATK_TOOL);
    await runPublishTool(context, ATK_TOOL, ['validate', ...flags]);
    await runPublishTool(context, ATK_TOOL, ['package', ...flags]);
    context.out('atk provision would register or update the app in Microsoft 365\n');
    if (!context.apply) return { changes: true, applied: false, nextSteps: [] };

    await runPublishTool(context, ATK_TOOL, ['provision', ...flags]);
    return {
      changes: true,
      applied: true,
      nextSteps: [
        `atk publish --env ${context.environment} --folder ${context.directory.replaceAll('\\', '/')} to submit it to the organization catalog (admin approval)`,
        'atk auth login if provision reported no signed-in account',
      ],
    };
  },
});
