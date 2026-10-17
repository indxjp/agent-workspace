import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The provider console page that creates a key, by the secret name `aw dev` asks for. */
const KEY_CONSOLES: Readonly<Record<string, { readonly provider: string; readonly url: string }>> =
  {
    ANTHROPIC_API_KEY: {
      provider: 'Anthropic',
      url: 'https://console.anthropic.com/settings/keys',
    },
    OPENAI_API_KEY: { provider: 'OpenAI', url: 'https://platform.openai.com/api-keys' },
  };

/** Where to create the key `secret` holds; `undefined` for a secret with no known provider. */
export function keyConsole(
  secret: string,
): { readonly provider: string; readonly url: string } | undefined {
  return KEY_CONSOLES[secret];
}

export interface OpenUrlOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether this is WSL; read from the environment and `/proc/version` when absent. */
  readonly wsl?: boolean;
  readonly spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** cmd.exe where WSL mounts the default Windows system drive. */
const WSL_CMD = '/mnt/c/Windows/System32/cmd.exe';

function isWsl(env: Readonly<Record<string, string | undefined>>): boolean {
  if ((env['WSL_DISTRO_NAME'] ?? '') !== '') return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The programs to try, in order, to open `url` in the default browser. Each is a command and an
 * argument list, never a shell line: the URL is one argument.
 */
export function openCommands(
  url: string,
  platform: NodeJS.Platform,
  wsl: boolean,
): readonly (readonly [string, ...string[]])[] {
  if (platform === 'win32') return [['rundll32', 'url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return [['open', url]];
  const wslview: readonly [string, ...string[]] = ['wslview', url];
  // `start` is a cmd.exe built-in, so only a URL cmd.exe cannot split or expand is passed to it.
  // By its Windows path too: WSL with `appendWindowsPath = false` has no cmd.exe on PATH, and
  // xdg-open there starts a Linux browser under WSLg instead of the Windows one (BH061-024).
  const cmds = ['cmd.exe', WSL_CMD].map((command): readonly [string, ...string[]] => [
    command,
    '/c',
    'start',
    '',
    url,
  ]);
  return [...(wsl ? [wslview, ...(/[&^|<>"%\s]/.test(url) ? [] : cmds)] : []), ['xdg-open', url]];
}

/**
 * Open `url` in the person's browser. `true` when a program started; `false` (nothing thrown) when
 * the URL is not http(s) or no program could be started, so the caller prints the URL instead.
 */
export async function openUrl(url: string, options: OpenUrlOptions = {}): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const start = options.spawn ?? spawn;
  for (const [command, ...args] of openCommands(url, platform, options.wsl ?? isWsl(env))) {
    const started = await new Promise<boolean>((resolve) => {
      try {
        const child = start(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
        child.once('error', () => {
          resolve(false);
        });
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
    if (started) return true;
  }
  return false;
}
