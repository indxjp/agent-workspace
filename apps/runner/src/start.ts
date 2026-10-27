import { runnerBaseEnvironment } from './environment.js';
import type { ResolvedRunRequest } from './resources.js';
import { sessionMirrorDeps, startAgentInThisContainer } from './index.js';
import { startRunnerServer } from './server.js';
import type { EngineStartOutcome } from './runtime.js';
import { MIRROR_TOKEN_ENV, readMirrorConfig } from './session.js';

export async function startRunner(env: Readonly<Record<string, string | undefined>> = process.env) {
  const base = runnerBaseEnvironment(env);
  const mirrorConfig = readMirrorConfig(env);
  if (mirrorConfig.kind === 'invalid') throw new Error(mirrorConfig.reason);
  const { server, address } = await startRunnerServer(env, {
    startAgent: (request: ResolvedRunRequest): Promise<EngineStartOutcome> =>
      startAgentInThisContainer(
        request,
        base,
        sessionMirrorDeps(env, request.env[MIRROR_TOKEN_ENV], request.engine),
      ),
  });
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
