/**
 * The runner manager as a Vercel Function (ADR-0126, ADR-0120 clause 7): the same listener
 * `startRunnerManager` serves, with the stateless allocation mode forced on, because an instance
 * keeps nothing between invocations. The listener is built by the first request; a configuration
 * error is not kept, so the next request reads the environment again, and the caller sees a generic
 * 500 while the cause goes to the function's log.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createRunnerManagerListener } from './manager.js';
import { runnerManagerOptionsFromEnvironment } from './manager-start.js';

type Environment = Readonly<Record<string, string | undefined>>;
type Listener = (req: IncomingMessage, res: ServerResponse) => void;

export function createRunnerManagerFunction(env: Environment = process.env): Listener {
  let listener: Listener | undefined;
  return (req, res) => {
    if (listener === undefined) {
      try {
        const { options } = runnerManagerOptionsFromEnvironment({
          ...env,
          RUNNER_MANAGER_STATELESS: 'true',
        });
        listener = createRunnerManagerListener(options);
      } catch (error) {
        process.stderr.write(
          `runner manager failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'runner_manager_unavailable' }));
        return;
      }
    }
    listener(req, res);
  };
}
