import { log } from '../../telemetry/logger';
import type { AgentEnvironment } from '@indx-workspace/contracts/agent-versions';
import {
  SurfaceAllowedOriginsSchema,
  type SurfaceDefinition,
} from '@indx-workspace/contracts/surfaces';

/**
 * Set by `agent-workspace deploy` to the project's own deployed frontend origin: the domain Vercel
 * confirmed (ADR-0128) or the Cloudflare frontend Worker's `workers.dev` origin (ADR-0129).
 */
const FRONTEND_ORIGIN_VARIABLE = 'AW_FRONTEND_ORIGIN';

/**
 * `surface` with the deployment's own frontend origin among its `allowedOrigins` (ADR-0128), only
 * when it is served from `production`: a draft (`local`) is never widened, so the try page and an
 * agent not promoted yet keep exactly what they list. The value is `unknown` until the contract's
 * origin schema accepts it and it is `https:`; anything else, or a list already full, is ignored
 * with a warning each time a surface is resolved, never thrown at a visitor.
 */
export function withDeploymentOrigin(
  surface: SurfaceDefinition,
  environment: AgentEnvironment,
  env: Readonly<Record<string, string | undefined>>,
): SurfaceDefinition {
  if (environment !== 'production') return surface;
  const origin = env[FRONTEND_ORIGIN_VARIABLE]?.trim() ?? '';
  if (origin === '') return surface;
  const listed = surface.allowedOrigins ?? [];
  if (listed.includes(origin)) return surface;
  const merged = SurfaceAllowedOriginsSchema.safeParse([...listed, origin]);
  if (!merged.success || !origin.startsWith('https://')) {
    log.warn(
      `[surfaces] ${FRONTEND_ORIGIN_VARIABLE} is not an https origin this surface can list, and is ignored.`,
    );
    return surface;
  }
  return { ...surface, allowedOrigins: merged.data };
}
