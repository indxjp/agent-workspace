import { currentSetupRuntimeDetection } from '../../../../server/setup/runtime-detection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which runtime drivers the first-run wizard may offer, and which one it should default to. The
 * answer comes from this deployment's configuration and a liveness check of its runner manager —
 * see `detectSetupRuntimes` — so the Docker Compose topology defaults to `docker` and every other
 * topology keeps defaulting to `local`. It is cached for a few seconds per process.
 */
export async function GET(): Promise<Response> {
  return Response.json(await currentSetupRuntimeDetection());
}
