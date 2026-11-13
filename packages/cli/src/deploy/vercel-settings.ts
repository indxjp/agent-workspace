import { composeProjectName } from '../render/env.ts';
import { type DeployContext } from './steps.ts';
import { type VercelTarget } from './vercel-parts.ts';

export const VERCEL_TOKEN_VARIABLE = 'VERCEL_TOKEN';

export const VERCEL_TEAM_ID_VARIABLE = 'VERCEL_TEAM_ID';

/** The project's name, set by `aw deploy`; a directory deploy names the project after its directory. */
const PROJECT_NAME_VARIABLE = 'AGENT_WORKSPACE_PROJECT_NAME';

/** The control plane's variable for its own frontend's origin, merged into surfaces' allowedOrigins (ADR-0128). */
export const FRONTEND_ORIGIN_VARIABLE = 'AW_FRONTEND_ORIGIN';

/** The value of a required environment variable, or a refusal that names it. */
export function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  purpose: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set: agent-workspace deploy reads ${purpose} from the environment, never ` +
        'from a flag or the profile. Set it and run again. Nothing was run.',
    );
  }
  return value;
}

/** `aw deploy` runs in a state directory named after the environment, so it names the project. */
export function namedTarget(context: DeployContext, selected: VercelTarget): VercelTarget {
  const named = context.env[PROJECT_NAME_VARIABLE]?.trim() ?? '';
  return named === '' ? selected : { ...selected, projectName: composeProjectName(named) };
}
