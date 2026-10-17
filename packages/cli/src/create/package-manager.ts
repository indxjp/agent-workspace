import { spawn } from 'node:child_process';

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** The package manager that ran `npm create` (`npm_config_user_agent`), npm when unknown. */
export function detectPackageManager(
  userAgent: string | undefined = process.env['npm_config_user_agent'],
): PackageManager {
  return PACKAGE_MANAGERS.find((name) => userAgent?.startsWith(`${name}/`) === true) ?? 'npm';
}

/**
 * How to start `<manager> <args>`. Only fixed words ever reach it (`install`, `run dev`), and the
 * project directory is the `cwd`, never part of the command. On Windows the managers are `.cmd`
 * shims, which Node refuses to spawn without a shell (EINVAL since 20.12), so there the one
 * command string goes through the shell; elsewhere no shell is involved.
 */
export function packageManagerSpawn(
  manager: PackageManager,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[]; readonly shell: boolean } {
  return platform === 'win32'
    ? { command: [manager, ...args].join(' '), args: [], shell: true }
    : { command: manager, args, shell: false };
}

/** Runs `<manager> <args>` in `cwd` with the terminal inherited; resolves with its exit code. */
export type RunInProject = (
  manager: PackageManager,
  args: readonly string[],
  cwd: string,
) => Promise<number>;

export function spawnInProject(
  manager: PackageManager,
  args: readonly string[],
  cwd: string,
  stdio: 'inherit' | 'ignore' = 'inherit',
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const spec = packageManagerSpawn(manager, args, platform);
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], { cwd, stdio, shell: spec.shell });
    child.once('error', () => resolve(127));
    child.once('close', (code) => resolve(code ?? 1));
  });
}
