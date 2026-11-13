import { failureOf, SURFACE_SOURCE, ROOT } from './harness-fixtures.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SURFACE_COLOUR,
  JOURNEY_BRAND_COLOUR,
  assertBrandColour,
  assertLauncherColour,
  colourOfSurfaceSource,
  devOrigin,
  parseDevLine,
} from './harness.mjs';

const DEV_LINE_CASES = [
  {
    line: 'ready http://127.0.0.1:3000\r',
    expected: { kind: 'ready', url: 'http://127.0.0.1:3000' },
  },
  { line: 'signed in as admin@example.com (workspace default)', expected: { kind: 'signedIn' } },
  {
    line: 'try: http://127.0.0.1:3000/p/s/main/try',
    expected: { kind: 'try', url: 'http://127.0.0.1:3000/p/s/main/try' },
  },
  {
    line: 'widget: <script src="http://127.0.0.1:3000/p/s/main/widget.js" async></script>',
    expected: { kind: 'widget', src: 'http://127.0.0.1:3000/p/s/main/widget.js' },
  },
  { line: 'model connection: default (anthropic)', expected: { kind: 'modelConnection' } },
  { line: 'synced: "assistant" created at version 1\r', expected: { kind: 'synced' } },
  {
    line: '  try       http://127.0.0.1:3000/p/s/main/try',
    expected: { kind: 'try', url: 'http://127.0.0.1:3000/p/s/main/try' },
  },
  {
    line: '  embed     <script src="http://127.0.0.1:3000/p/s/main/widget.js" async></script>',
    expected: { kind: 'widget', src: 'http://127.0.0.1:3000/p/s/main/widget.js' },
  },
];

describe('the dev lines (C5, C6)', () => {
  it.each(DEV_LINE_CASES)('reads $line', ({ line, expected }) => {
    expect(parseDevLine(line)).toEqual(expected);
  });

  it('takes the ready origin from the ready, try or embed line', () => {
    const origin = 'http://127.0.0.1:3000';
    expect(devOrigin(parseDevLine(`ready ${origin}`))).toBe(origin);
    expect(devOrigin(parseDevLine(`  try       ${origin}/p/s/main/try`))).toBe(origin);
    expect(
      devOrigin(
        parseDevLine(`  embed     <script src="${origin}/p/s/main/widget.js" async></script>`),
      ),
    ).toBe(origin);
    expect(devOrigin(parseDevLine('  ✓ runtime   ready in 6.1 s   logs: x'))).toBeNull();
    expect(devOrigin(null)).toBeNull();
  });

  it('reads the bootstrap admin’s email from the ready screen’s console row', () => {
    expect(parseDevLine('            sign in as admin@localhost.test\r')).toEqual({
      kind: 'adminSignIn',
      email: 'admin@localhost.test',
    });
    // The password is never printed (BH061-011): the next row only names its file.
    expect(parseDevLine('            password in .agent-workspace/local-secrets.json')).toBeNull();
  });

  it('issue #1510: reads the console and app origins from the ready screen', () => {
    expect(parseDevLine('  console   http://127.0.0.1:3000\r')).toEqual({
      kind: 'console',
      origin: 'http://127.0.0.1:3000',
    });
    expect(parseDevLine('  app       http://127.0.0.1:3100')).toEqual({
      kind: 'app',
      origin: 'http://127.0.0.1:3100',
    });
    // Neither row is a server origin the journey's B1 waits on.
    expect(devOrigin(parseDevLine('  app       http://127.0.0.1:3100'))).toBeNull();
    expect(parseDevLine('applied: connector portal (new)')).toBeNull();
    expect(parseDevLine('  app       npx aw chat')).toBeNull();
    expect(parseDevLine('  chat      npx aw chat')).toBeNull();
  });

  it('reads nothing from a line that is not one of them', () => {
    for (const line of [
      'ready',
      'ready ftp://127.0.0.1:3000',
      'signed in as admin@example.com',
      'widget: <script src="http://127.0.0.1:3000/p/s/main/widget.js"></script>',
      'try: http://127.0.0.1:3000/p/s/main',
      'model connection: other (anthropic)',
      // A later start names where the password is, never the password.
      'Sign in at http://127.0.0.1:3000 as admin@localhost.test; the password is in /x/local-secrets.json',
      'Sign in at http://127.0.0.1:3000 as admin@localhost.test; the password is BOOTSTRAP_ADMIN_PASSWORD, set in the environment or .env',
      'synced:',
      '',
    ]) {
      expect(parseDevLine(line)).toBeNull();
    }
  });
});

describe('the launcher colour', () => {
  it('takes theme.colour from the rendered surfaces/main.ts', () => {
    expect(colourOfSurfaceSource(SURFACE_SOURCE)).toBe('#2f5fd0');
  });

  it('fails when surfaces/main.ts names no colour', () => {
    expect(failureOf(() => colourOfSurfaceSource("export default { name: 'main' };")).message).toBe(
      'surfaces/main.ts names no theme colour (colour: #rrggbb)',
    );
  });

  it('accepts the same colour as rgb() or opaque rgba()', () => {
    expect(() => assertLauncherColour('#2f5fd0', 'rgb(47, 95, 208)')).not.toThrow();
    expect(() => assertLauncherColour('#2F5FD0', 'rgba(47, 95, 208, 1)')).not.toThrow();
  });

  it('fails on a wrong colour, naming both', () => {
    expect(failureOf(() => assertLauncherColour('#2f5fd0', 'rgb(0, 0, 0)')).message).toBe(
      "launcher colour rgb(0, 0, 0) is not surfaces/main.ts's #2f5fd0",
    );
    expect(
      failureOf(() => assertLauncherColour('#2f5fd0', 'rgba(47, 95, 208, 0.5)')).message,
    ).toContain('launcher colour rgba(47, 95, 208, 0.5)');
  });
});

describe('regression: the brand colour can tell the theme from the default', () => {
  it('names the widget default, which is also the question recommended answer', () => {
    const theme = readFileSync(path.join(ROOT, 'packages', 'react', 'src', 'theme.ts'), 'utf8');
    expect(theme).toMatch(new RegExp(`^ {2}colour: '${DEFAULT_SURFACE_COLOUR}',$`, 'mu'));
    const setup = readFileSync(path.join(ROOT, 'packages', 'contracts', 'src', 'setup.ts'), 'utf8');
    expect(setup).toContain(`recommended: '${DEFAULT_SURFACE_COLOUR}',`);
  });

  it('answers a brand colour that is not the default', () => {
    expect(JOURNEY_BRAND_COLOUR).toMatch(/^#[0-9a-f]{6}$/u);
    expect(JOURNEY_BRAND_COLOUR).not.toBe(DEFAULT_SURFACE_COLOUR);
    expect(() => assertBrandColour('#C0392B', JOURNEY_BRAND_COLOUR)).not.toThrow();
  });

  it('refuses the default colour, which the launcher shows without any theme', () => {
    expect(failureOf(() => assertBrandColour('#2f5fd0', '#2F5FD0')).message).toBe(
      "the brand colour #2F5FD0 is the widget's default, so the launcher cannot prove it",
    );
  });

  it('refuses a file that does not name the answered colour', () => {
    expect(failureOf(() => assertBrandColour('#2f5fd0', '#c0392b')).message).toBe(
      'surfaces/main.ts names #2f5fd0, not the answered brand colour #c0392b',
    );
  });
});
