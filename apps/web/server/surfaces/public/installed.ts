/**
 * The surface session bootstrap the composition root installed, and the environment it reads
 * (F-23: the environment is read in the composition root and injected, refactoring plan part 05).
 */
import { applicationContext } from '../../application-context';
import type { SurfaceConditionEnvironment } from './conditions';
import type { SurfaceSessionsRuntime } from './runtime';

/** The installed bootstrap, or `null` while it is not `serving`. */
export function surfaceSessions(): SurfaceSessionsRuntime | null {
  const surfaces = applicationContext()?.surfaces;
  return surfaces?.kind === 'serving' ? surfaces.runtime : null;
}

/**
 * The installed bootstrap's environment, read on every call; empty while none is installed. With
 * no bootstrap every surface handler answers before the environment can change its answer.
 */
export function installedEnvironment(): SurfaceConditionEnvironment {
  return surfaceSessions()?.env() ?? {};
}
