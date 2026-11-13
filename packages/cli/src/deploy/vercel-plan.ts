import { type DeployContext, type DeployOutcome } from './steps.ts';
import { type Part, type VercelTarget, partsOf } from './vercel-parts.ts';
import { ENVIRONMENT } from './vercel-projects.ts';
import { FRONTEND_ORIGIN_VARIABLE, VERCEL_TEAM_ID_VARIABLE } from './vercel-settings.ts';

/** What a plan says of the Root Directory each platform project will be given. */
export function rootDirectoryNote(parts: readonly Part[]): string {
  return parts
    .filter(({ rootDirectory }) => rootDirectory !== undefined)
    .map(
      ({ project, rootDirectory }) =>
        `Root Directory of ${project} will be set to ${rootDirectory ?? 'the upload root'}.\n`,
    )
    .join('');
}

/** What a plan says of the frontend's origin, or nothing when the project has no frontend. */
export function frontendNote(parts: readonly Part[]): string {
  return parts.some((part) => part.label === 'frontend')
    ? ` The frontend is deployed before the control plane, and its origin is set as ${FRONTEND_ORIGIN_VARIABLE} there once Vercel lists it for the deployment.`
    : '';
}

/**
 * BH061-027: a plan without the token or team id reads nothing from Vercel, so it lists what an
 * apply sets on projects that do not exist yet instead of refusing.
 */
export function planOffline(
  context: DeployContext,
  target: VercelTarget,
  dotEnv: Readonly<Record<string, string>>,
  unset: readonly string[],
): DeployOutcome {
  const { parts } = partsOf(context, target, `<${VERCEL_TEAM_ID_VARIABLE}>`, dotEnv);
  context.out(
    `${unset.join(' and ')} ${unset.length === 1 ? 'is' : 'are'} not set, so this plan reads ` +
      'nothing from Vercel: it lists what an apply sets on projects that do not exist yet.\n' +
      parts
        .map(
          (part) =>
            `Vercel project ${part.project} (${part.label}): ${String(part.variables.length)} ` +
            `${ENVIRONMENT} variable(s): ${part.variables.map(([name]) => name).join(', ')}.\n`,
        )
        .join('') +
      rootDirectoryNote(parts),
  );
  return { changes: true, applied: false };
}
