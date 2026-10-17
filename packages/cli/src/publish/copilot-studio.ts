/**
 * Copilot Studio, published with the Power Platform CLI's `pac solution pack` and `pac solution
 * import` (https://learn.microsoft.com/power-platform/developer/cli/reference/solution, read
 * 2026-10-10). `pac` keeps its login (`pac auth create`) to itself: nothing here passes a credential.
 *
 * VERIFY (P3b, Owner-assisted): the exported cloned-agent folder (`agent/**`, `connectors/**`) is a
 * solution folder `pac solution pack` accepts; the YAML source-control format needs a
 * `solutions/<name>/solution.yml`. Until P3b commits a sanitized fixture the pack is only exercised
 * against the fake runner, so the import is gated behind `--experimental`.
 *
 * `pac` targets the environment of the active `pac auth` profile; there is no environment setting.
 *
 * VERIFY: that `pac help` exits 0 and prints the version banner the 2.4.1 floor is read from, and the
 * install line: https://learn.microsoft.com/power-platform/developer/cli/introduction
 */
import path from 'node:path';

import { z } from 'zod';

import {
  defineExecutor,
  PublishRefusedError,
  requireTool,
  runPublishTool,
  type PublishOutcome,
  type PublishTool,
} from './kit.ts';

const PAC_TOOL: PublishTool = {
  name: 'pac',
  versionArgs: ['help'],
  // The YAML source-control solution format.
  minimumVersion: '2.4.1',
  install: 'dotnet tool install --global Microsoft.PowerApps.CLI.Tool',
  docsUrl: 'https://learn.microsoft.com/power-platform/developer/cli/reference/solution',
};

/**
 * The solution unique name derived from the root agent name: every character outside
 * `[A-Za-z0-9_]` becomes `_`, and a leading digit gets a `_` in front (`support-triage` →
 * `support_triage`).
 *
 * VERIFY: the unique-name rule (letters, digits and `_`, not starting with a digit):
 * https://learn.microsoft.com/power-apps/maker/data-platform/create-solution
 */
export function solutionNameOf(agent: string): string {
  const name = agent.replace(/[^A-Za-z0-9_]/gu, '_');
  return /^[0-9]/u.test(name) ? `_${name}` : name;
}

const AUTH_NOTE =
  'pac uses the active pac auth profile (pac auth list); create one with pac auth create --environment <environment url>, or switch with pac auth select';

export const copilotStudio = defineExecutor({
  tools: [PAC_TOOL],
  defaultEnvironment: 'default',
  // Compile keys (`publisherPrefix`, …) share the merged settings and were validated when the
  // bundle was exported; `pac solution pack|import` takes none of them, so they are stripped.
  settingsSchema: z.object({}),
  async publish(context): Promise<PublishOutcome> {
    await requireTool(context, PAC_TOOL);

    // `--zipfile` must be a full path, and outside `--folder`: a zip inside the folder it packs
    // would be packed into the next run's solution.
    const zipfile = path.join(
      path.dirname(context.directory),
      `${solutionNameOf(context.agent)}.zip`,
    );
    await runPublishTool(context, PAC_TOOL, [
      'solution',
      'pack',
      '--zipfile',
      zipfile,
      '--folder',
      context.directory,
      '--packagetype',
      'Unmanaged',
    ]);
    context.out(`${AUTH_NOTE}\n`);

    if (!context.apply) {
      return {
        changes: true,
        applied: false,
        nextSteps: [
          AUTH_NOTE,
          `import ${zipfile} in Copilot Studio or the VS Code extension, or re-run with --experimental --yes`,
        ],
      };
    }
    if (!context.experimental) {
      throw new PublishRefusedError(
        'publishing to Copilot Studio is experimental until the agent folder schema is verified (P3b)',
        `import ${zipfile} in Copilot Studio or the VS Code extension, or re-run with --experimental`,
      );
    }

    await runPublishTool(context, PAC_TOOL, [
      'solution',
      'import',
      '--path',
      zipfile,
      '--publish-changes',
    ]);
    return { changes: true, applied: true, nextSteps: [] };
  },
});
