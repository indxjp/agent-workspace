import path from 'node:path';
import type { ToolResult } from './runner.ts';
import { runStep, type DeployContext } from './steps.ts';
import { vercelProductionUrl, type Part } from './vercel-parts.ts';
import { configurePart, inspectPart, linkedTo } from './vercel-projects.ts';
import { FRONTEND_ORIGIN_VARIABLE } from './vercel-settings.ts';
import {
  assertStageable,
  removeStaged,
  stageDirectory,
  stagePlatform,
  writeFunctionEntry,
} from './vercel-upload.ts';

/** Staging happens part by part during the apply; what it would refuse is refused before it. */
export async function assertPartsStageable(
  source: string | null,
  parts: readonly Part[],
): Promise<void> {
  if (source === null) return;
  for (const { upload, functionEntry } of parts) {
    if ('platformPackage' in upload) {
      await assertStageable(source, upload.platformPackage, {
        functionEntry: functionEntry === true,
      });
    }
  }
}

/** The deployment URL `vercel deploy` printed: its last stdout line, when that is a bare https vercel.app origin. */
function deploymentUrlOf(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? '';
  try {
    const url = new URL(line);
    const bare = url.origin === line && url.username === '' && url.password === '';
    return url.protocol === 'https:' && bare && url.hostname.endsWith('.vercel.app') ? line : null;
  } catch {
    return null;
  }
}

/**
 * Tells the control plane its frontend's origin, once Vercel itself lists it for the deployment
 * just made (ADR-0128). The origin is the frontend project's production domain, known from its
 * name, and is trusted only after `vercel inspect` of the new deployment names it, so a
 * `<name>-web.vercel.app` that belongs to someone else is never written. `inspect`'s output is
 * undocumented, so a change in it fails closed: nothing is written and the operator is told to
 * list the origin by hand. The variable goes through `inspectPart` and `configurePart` like every
 * other one, so a re-deploy leaves an existing value as it is.
 */
interface FrontendDeployment {
  readonly frontend: Part;
  readonly controlPlane: Part;
  readonly team: string;
  readonly deployed: ToolResult;
}

export async function allowFrontendOrigin(
  context: DeployContext,
  { frontend, controlPlane, team, deployed }: FrontendDeployment,
): Promise<void> {
  const origin = vercelProductionUrl(frontend.project);
  const deployment = deploymentUrlOf(deployed.stdout);
  let confirmed = false;
  if (deployment !== null) {
    const inspected = await runStep(context, 'vercel', ['inspect', deployment, '--scope', team], {
      show: false,
      accept: [0, 1],
      env: linkedTo(team, frontend.project),
    });
    confirmed =
      inspected.status === 0 &&
      `${inspected.stdout}\n${inspected.stderr}`.split(/\s+/u).includes(origin);
  }
  if (!confirmed) {
    context.out(
      `Vercel did not list ${origin} for the new frontend deployment, so the control plane was ` +
        `not told to allow it. List ${origin} in allowedOrigins of the surface web/ calls, or ` +
        `set ${FRONTEND_ORIGIN_VARIABLE}=${origin} in ${controlPlane.project} and deploy again.\n`,
    );
    return;
  }
  // No Root Directory: `configurePart` has already set it for the control plane.
  const part: Part = {
    label: controlPlane.label,
    project: controlPlane.project,
    settingsFile: controlPlane.settingsFile,
    upload: controlPlane.upload,
    variables: [[FRONTEND_ORIGIN_VARIABLE, origin]],
  };
  await configurePart(context, part, team, await inspectPart(context, part, team));
}

/** Stages the part and runs `vercel deploy --prod` on it; the staged copy is always removed. */
export async function deployPart(
  context: DeployContext,
  part: Part,
  source: string,
  team: string,
): Promise<ToolResult> {
  // One archive of a pruned copy, not a request per file of the checkout: a free team is
  // refused after 5000 files.
  const staged =
    'directory' in part.upload
      ? await stageDirectory(part.upload.directory)
      : await stagePlatform(source, part.upload.platformPackage);
  try {
    if (part.functionEntry === true && 'platformPackage' in part.upload) {
      await writeFunctionEntry(staged, part.upload.platformPackage);
    }
    // `--cwd`, not a positional path: the CLI warns "Did you mean to deploy the subdirectory
    // deploy?" when it runs in the project, which has a `deploy/` folder.
    return await runStep(
      context,
      'vercel',
      [
        'deploy',
        '--cwd',
        staged,
        '--archive=tgz',
        '--prod',
        '--yes',
        '--scope',
        team,
        '--local-config',
        path.resolve(context.directory, part.settingsFile),
      ],
      { show: true, env: linkedTo(team, part.project) },
    );
  } finally {
    await removeStaged(staged);
  }
}
