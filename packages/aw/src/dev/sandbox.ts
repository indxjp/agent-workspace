import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CommandRefusedError } from '../io.js';

/** Where the driver `aw dev` runs on came from: `--sandbox`, or the project file's own key. */
type SandboxSource = 'flag' | 'yaml';

export interface Sandbox {
  readonly driver: string;
  readonly source: SandboxSource;
}

/** What runs a command for the probe; `execFile` by default, a fake in tests. */
export type Exec = (
  file: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeout: number },
) => Promise<unknown>;

const execFileAsync: Exec = promisify(execFile);

/** The `--sandbox` flag beats the project file's `runtime.default`; neither leaves `aw dev` as it was. */
export function devSandbox(
  flag: string | undefined,
  yaml: string | undefined,
): Sandbox | undefined {
  if (flag !== undefined) return { driver: flag, source: 'flag' };
  return yaml === undefined ? undefined : { driver: yaml, source: 'yaml' };
}

/**
 * Refuse, before anything is forked, a docker sandbox whose daemon does not answer. The probe is
 * the one the CLI's driver check uses (`docker version` talks to the daemon, not just the binary).
 */
export async function requireDocker(
  sandbox: Sandbox | undefined,
  env: Readonly<Record<string, string | undefined>>,
  exec: Exec = execFileAsync,
): Promise<void> {
  if (sandbox?.driver !== 'docker') return;
  try {
    await exec('docker', ['version', '--format', '{{.Server.Version}}'], {
      env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
      timeout: 10_000,
    });
  } catch {
    const from =
      sandbox.source === 'flag' ? '--sandbox docker' : 'environments.local.runtime.default: docker';
    throw new CommandRefusedError(
      `${from}: Docker is not reachable, so aw dev cannot run the docker sandbox`,
      'start Docker so that `docker version` answers, or run without the docker sandbox',
    );
  }
}

/** The one line printed once per start when agents that can run commands run unsandboxed. */
export function unsandboxedLine(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  const who = [...names].sort().join(', ');
  return `warning: ${who} can run commands, and aw dev runs ${names.length === 1 ? 'it' : 'them'} on the local driver with no sandbox: commands run as you, with your files, network and environment\n`;
}
