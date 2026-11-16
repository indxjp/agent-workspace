import { parseArgs } from 'node:util';
import { JourneyFailure, registryOf } from '../journey/harness.mjs';
import { SHELL_NAMES } from './host.mjs';

/**
 * @param {readonly string[]} argv @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ registry: string | null, live: boolean, apiKey: string, staticOnly: boolean,
 *   machine: 'container' | 'host', shell: string }}
 */
export function parseArguments(argv, env) {
  const usage =
    'usage: node tests/docs-claims/run.mjs [--registry <url>] [--model fake|live] [--static] [--machine container|host [--shell sh|bash|pwsh]]';
  /** @type {{ registry?: string, model?: string, static?: boolean, machine?: string, shell?: string }} */
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        registry: { type: 'string' },
        model: { type: 'string' },
        static: { type: 'boolean' },
        machine: { type: 'string' },
        shell: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    throw new JourneyFailure(
      `${usage} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const model = values.model ?? 'fake';
  if (model !== 'fake' && model !== 'live') {
    throw new JourneyFailure(`${usage} (--model is fake or live, not "${model}")`);
  }
  const machine = values.machine ?? 'container';
  if (machine !== 'container' && machine !== 'host') {
    throw new JourneyFailure(`${usage} (--machine is container or host, not "${machine}")`);
  }
  if (values.shell !== undefined && !SHELL_NAMES.includes(values.shell)) {
    throw new JourneyFailure(
      `${usage} (--shell is ${SHELL_NAMES.join(', ')}, not "${values.shell}")`,
    );
  }
  if (machine === 'container' && values.shell !== undefined) {
    throw new JourneyFailure(`${usage} (--shell needs --machine host; the container runs sh)`);
  }
  const registry = registryOf(values.registry);
  if (machine === 'host' && registry === null) {
    throw new JourneyFailure(`${usage} (--machine host needs --registry: there is no Verdaccio)`);
  }
  return {
    registry,
    live: model === 'live',
    apiKey: env['ANTHROPIC_API_KEY']?.trim() ?? '',
    staticOnly: values.static === true,
    machine,
    shell: values.shell ?? 'sh',
  };
}
