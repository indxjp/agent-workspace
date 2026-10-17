import { styleText } from 'node:util';

import type { PackageManager } from './package-manager.ts';

type Format = 'bold' | 'cyan' | 'dim' | 'green';

/** Colour only on a terminal that wants it; captured output and `NO_COLOR` stay plain. */
export function paint(format: Format, text: string): string {
  return process.stdout.isTTY === true && (process.env['NO_COLOR'] ?? '') === ''
    ? styleText(format, text, { validateStream: false })
    : text;
}

/**
 * A directory as a shell argument: bare when it is plain, quoted otherwise. POSIX shells get
 * single quotes, which, unlike double quotes, stop `$( )` and backtick substitution, so a printed
 * hint the operator copies never runs a command embedded in the directory name; a `'` inside is
 * closed, escaped and reopened (`'\''`). PowerShell and cmd both read double quotes; the single-quoted
 * form, for a value with `$` or a backtick (`''` for a `'`), is PowerShell's, which keeps it literal.
 */
export function shellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[\w./:\\-]+$/u.test(value)) return value;
  if (platform !== 'win32') return `'${value.replaceAll("'", String.raw`'\''`)}'`;
  // PowerShell expands `$` and the backtick inside double quotes; single quotes are literal there.
  return /[$`]/u.test(value) ? `'${value.replaceAll("'", "''")}'` : `"${value}"`;
}

/** What is left for the person to do, in order: cd, install, set the key, run. */
export function nextStepLines(options: {
  readonly target: string;
  readonly manager: PackageManager;
  readonly installed: boolean;
  /** The model key's variable when it is not set in this environment, else `null`. */
  readonly missingKey: string | null;
  readonly platform?: NodeJS.Platform;
}): readonly string[] {
  const { target, manager, installed, missingKey, platform = process.platform } = options;
  const lines = [`cd ${shellArgument(target, platform)}`];
  if (!installed) lines.push(`${manager} install`);
  if (missingKey !== null) {
    lines.push(
      ...(platform === 'win32'
        ? [
            `PowerShell: $env:${missingKey}="<your key>"`,
            `cmd:        set ${missingKey}=<your key>`,
          ]
        : [`export ${missingKey}=<your key>`]),
    );
  }
  lines.push(`${manager} run dev`);
  return lines;
}

/**
 * BH061-034: under WSL a project on a Windows drive (`/mnt/c/...`) installs several times slower
 * than on the Linux filesystem, and the local runtime's database is slow there too. `null` when
 * the directory is not on one, or this is not WSL.
 */
export function windowsDriveWarning(destination: string, wsl: boolean): string | null {
  if (!wsl || !/^\/mnt\/[a-z](?:\/|$)/u.test(destination)) return null;
  return (
    `note: ${destination} is on a Windows drive; under WSL the install and the local runtime ` +
    'are much slower there. For a faster project, create it under your Linux home (~/) instead.\n'
  );
}
