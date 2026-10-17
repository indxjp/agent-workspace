import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CREDENTIAL_INPUT_PROPS, ONE_TIME_CODE_INPUT_PROPS } from './credential-input';

/** `apps/web`, the tree the guard below scans. */
const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCANNED = ['app', 'components'] as const;

/** What a password-type input may carry: the stored-credential props, or the one-time code. */
const SANCTIONED = [
  '{...CREDENTIAL_INPUT_PROPS}',
  "credential: 'stored'",
  "credential: 'one-time-code'",
] as const;

/**
 * The password inputs that are deliberately neither: the sign-in password, which a password
 * manager should fill, and a share passphrase the person sets for others. Each is pinned by the
 * marker its own element must carry, so an allowlisted file cannot grow a second, unvetted field.
 */
const ALLOWLIST: readonly { readonly file: string; readonly marker: string }[] = [
  { file: 'app/signin/page.tsx', marker: 'autoComplete="current-password"' },
  { file: 'components/shares/share-dialog.tsx', marker: 'setPassphrase' },
];

const PASSWORD_TYPE = /type(?:=|:\s*)["']password["']/u;
const ELEMENT_START = /<input\b|controlledInput\(|=\s*\{$/u;
const ELEMENT_END = /\/>|\}\)|^\s*\};?$/u;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [full] : [];
  });
}

function isComment(line: string): boolean {
  return /^\s*(?:\*|\/\/|\/\*)/u.test(line);
}

/** The lines of the element or options object around line `index`. */
function elementAround(lines: readonly string[], index: number): string {
  let start = index;
  while (start > 0 && !ELEMENT_START.test(lines[start] ?? '')) start -= 1;
  let end = index;
  while (end < lines.length - 1 && !ELEMENT_END.test(lines[end] ?? '')) end += 1;
  return lines.slice(start, end + 1).join('\n');
}

/** Every password-type input under `apps/web/{app,components}` that is not sanctioned. */
function unsanctionedPasswordInputs(): string[] {
  const offenders: string[] = [];
  for (const file of SCANNED.flatMap((dir) => sourceFiles(path.join(WEB_ROOT, dir)))) {
    const relative = path.relative(WEB_ROOT, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (isComment(line) || !PASSWORD_TYPE.test(line)) return;
      const element = elementAround(lines, index);
      if (element.includes('new-password')) {
        offenders.push(`${relative}:${String(index + 1)} asks for a new password`);
        return;
      }
      if (SANCTIONED.some((props) => element.includes(props))) return;
      const allowed = ALLOWLIST.some(
        (entry) => entry.file === relative && element.includes(entry.marker),
      );
      if (!allowed) {
        offenders.push(
          `${relative}:${String(index + 1)} is a password input without CREDENTIAL_INPUT_PROPS`,
        );
      }
    });
  }
  return offenders;
}

describe('credential inputs across apps/web', () => {
  it('turns off browser suggestions and tells password managers to skip a stored credential', () => {
    expect(CREDENTIAL_INPUT_PROPS).toEqual({
      autoComplete: 'off',
      'data-1p-ignore': 'true',
      'data-lpignore': 'true',
    });
  });

  // Chrome ignores `off` on a password input; `one-time-code` is not a site password to it.
  it('marks the one-time setup password as a one-time code, with the same opt-outs', () => {
    expect(ONE_TIME_CODE_INPUT_PROPS).toEqual({
      autoComplete: 'one-time-code',
      'data-1p-ignore': 'true',
      'data-lpignore': 'true',
    });
  });

  // PR #418 review: the Owner's bug was a credential field that invited a generated or saved
  // password. Every password input must be a sanctioned credential field or an allowlisted one.
  it('leaves no password input unsanctioned, naming the file and line of any that is', () => {
    expect(unsanctionedPasswordInputs()).toEqual([]);
  });

  it('finds the inputs it vets, so a scanner that matched nothing cannot pass', () => {
    const found = SCANNED.flatMap((dir) => sourceFiles(path.join(WEB_ROOT, dir))).filter((file) =>
      readFileSync(file, 'utf8')
        .split(/\r?\n/u)
        .some((line) => !isComment(line) && PASSWORD_TYPE.test(line)),
    );
    const relative = found.map((file) => path.relative(WEB_ROOT, file).split(path.sep).join('/'));
    for (const expected of [
      'app/signin/page.tsx',
      'components/models/add-provider-screen.tsx',
      'components/models/provider-detail.tsx',
      'components/resources/resource-screens.tsx',
      'components/setup/setup-wizard.tsx',
      'components/shares/share-dialog.tsx',
    ]) {
      expect(relative).toContain(expected);
    }
  });
});
