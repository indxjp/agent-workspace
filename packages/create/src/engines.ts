/** The Node major the packages' `engines` require (`>=24`). */
const REQUIRED_NODE_MAJOR = 24;

/**
 * The one line that tells a person on an older Node what to do, or `null` when `version` is new
 * enough. Kept free of imports: it runs before the generator is loaded, which on an old Node would
 * fail to link and say nothing useful. It starts with `error:` so it stands out among npm's own
 * engine warnings, and names `nvm use` too, since an installed Node 24 is often not the active one
 * (BH061-068).
 */
export function nodeTooOld(version: string): string | null {
  const major = String(REQUIRED_NODE_MAJOR);
  return Number(version.split('.')[0]) >= REQUIRED_NODE_MAJOR
    ? null
    : `error: Agent Workspace needs Node ${major} or newer; you have v${version}. ` +
        `Install it from https://nodejs.org, or with nvm: nvm install ${major} && nvm use ${major}`;
}

/** A Windows path into a WSL distribution: `\\wsl$\…` or `\\wsl.localhost\…`. */
const WSL_SHARE = /^\\\\wsl(?:\$|\.localhost)\\/iu;

/**
 * Windows Node run from a WSL shell (npm found through `/mnt/c` on the PATH): cmd.exe cannot start
 * in a WSL directory, so the generator would run in `C:\Windows` and fail there with EPERM
 * (BH061-009). npm keeps the directory it was started in as `INIT_CWD`. The line to print, or
 * `null` when this is not that case.
 */
export function windowsNodeInWsl(
  platform: string,
  cwd: string,
  initCwd: string | undefined,
): string | null {
  if (platform !== 'win32') return null;
  if (!WSL_SHARE.test(cwd) && !WSL_SHARE.test(initCwd ?? '')) return null;
  return (
    'error: this is Windows Node.js running inside WSL (npm from /mnt/c on your PATH), and it ' +
    `cannot write into a WSL directory. Install Node ${String(REQUIRED_NODE_MAJOR)} inside the ` +
    'Linux distribution (for example with nvm), check that `which node` is not under /mnt/c, ' +
    'and run the command again.'
  );
}
