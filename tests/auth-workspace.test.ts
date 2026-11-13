import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIN_SESSION_SECRET_LENGTH,
  mintSessionToken,
  newSessionClaims,
  verifySessionToken,
} from '../apps/web/server/auth/session.js';
import { WorkspaceScope, workspaceScopeFrom } from '../apps/web/server/auth/workspace.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SECRET = 'a'.repeat(MIN_SESSION_SECRET_LENGTH);

describe('a genuine WorkspaceScope cannot have its tenant mutated in place (runtime)', () => {
  const VICTIM = 'victim-tenant';

  const realScope = async (): Promise<WorkspaceScope> => {
    const token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
    const result = await verifySessionToken(token, SECRET);
    if (!result.ok) throw new Error(result.reason);
    return workspaceScopeFrom(result.claims);
  };

  it('is frozen the moment it exists, which is what the routes below all run into', async () => {
    const scope = await realScope();
    expect(Object.isFrozen(scope)).toBe(true);
    expect(WorkspaceScope.isWorkspaceScope(scope)).toBe(true);
    expect(scope.workspaceSlug).toBe('default');
  });

  // One entry per mutation route a handler could plausibly write. The first is the exact line
  // verification round 2 used to refute the previous version of this property.
  type Mutation = [name: string, mutate: (scope: WorkspaceScope) => void];
  const mutations: Mutation[] = [
    [
      'Object.assign of the tenant',
      (scope): void => {
        Object.assign(scope, { workspaceSlug: VICTIM });
      },
    ],
    [
      'Object.assign of every field at once',
      (scope): void => {
        Object.assign(scope, {
          workspaceSlug: VICTIM,
          actorEmail: 'attacker@evil.test',
          role: 'owner',
        });
      },
    ],
    [
      'direct assignment',
      (scope): void => {
        (scope as { workspaceSlug: string }).workspaceSlug = VICTIM;
      },
    ],
    [
      'Object.defineProperty',
      (scope): void => {
        Object.defineProperty(scope, 'workspaceSlug', { value: VICTIM, writable: true });
      },
    ],
    [
      'Object.setPrototypeOf',
      (scope): void => {
        Object.setPrototypeOf(scope, null);
      },
    ],
    [
      'adding a field the class never declared',
      (scope): void => {
        Object.assign(scope, { workspaceId: VICTIM });
      },
    ],
    [
      'delete',
      (scope): void => {
        delete (scope as { workspaceSlug?: string }).workspaceSlug;
      },
    ],
  ];

  it.each(mutations)('refuses %s, and the tenant is unchanged afterwards', async (name, mutate) => {
    const scope = await realScope();
    expect(() => {
      mutate(scope);
    }, name).toThrow(TypeError);
    // The point of the test. A throw that had already landed the write would pass the line above.
    expect(scope.workspaceSlug, name).toBe('default');
    expect(scope.actorEmail, name).toBe('admin@example.com');
    expect(JSON.stringify(scope), name).toBe(
      '{"workspaceSlug":"default","actorEmail":"admin@example.com"}',
    );
    expect(WorkspaceScope.isWorkspaceScope(scope), name).toBe(true);
  });

  /**
   * The guard's other half. It used to ask only whether the private field was present, which is a
   * question about shape: an object that had been mutated still had the field and still answered
   * `true`. It now also requires the object to be frozen and each public field to equal what the
   * constructor took from the verified session.
   */
  it('answers false for every value that is shaped like a scope but is not one', async () => {
    const scope = await realScope();
    const impostors: readonly (readonly [string, unknown])[] = [
      ['Object.create(prototype)', Object.create(WorkspaceScope.prototype) as unknown],
      ['a spread copy of a real scope', { ...scope }],
      ['a JSON round-trip', JSON.parse(JSON.stringify(scope)) as unknown],
      ['a structuredClone', structuredClone(scope)],
      [
        'a hand-written literal',
        { workspaceSlug: VICTIM, actorEmail: 'attacker@evil.test', role: 'owner' },
      ],
      ['a frozen hand-written literal', Object.freeze({ workspaceSlug: VICTIM })],
      ['null', null],
      ['a number', 42],
      ['undefined', undefined],
    ];
    for (const [label, impostor] of impostors) {
      expect(WorkspaceScope.isWorkspaceScope(impostor), label).toBe(false);
    }
    // And the positive half, so this test cannot pass by the guard answering false to everything.
    expect(WorkspaceScope.isWorkspaceScope(scope)).toBe(true);
  });
});

describe('a WorkspaceScope cannot be forged from request data (compile-time)', () => {
  const fixtureDir = path.join(repoRoot, 'node_modules', '.w1cp06-type-negative');
  const fixtureFile = path.join(fixtureDir, 'forgery.ts');
  const posix = (value: string): string => value.split(path.sep).join('/');

  /**
   * `node_modules` because it is the one directory inside the repository that no `tsconfig.json`
   * includes, that ESLint ignores by default and that git ignores — so a fixture that must NOT
   * type-check cannot break `pnpm typecheck`, `npx eslint .` or a working tree three sessions
   * are writing to, and a crashed run leaves nothing tracked behind.
   */
  const fixtureSource = [
    "import { workspaceScopeFrom, WorkspaceScope } from '../../apps/web/server/auth/workspace.js';",
    "import { mintSessionToken, newSessionClaims, verifySessionToken } from '../../apps/web/server/auth/session.js';",
    "import type { VerifiedSessionClaims } from '../../apps/web/server/auth/session.js';",
    '',
    "const body = JSON.parse('{}') as { email: string; workspace: string; role: 'owner' };",
    '',
    '// Every shape a handler author could plausibly reach for, one per line.',
    "export const a = workspaceScopeFrom({ sub: body.email, ws: body.workspace, role: 'owner' }); // FORBIDDEN partial claims from a request body",
    'export const b = workspaceScopeFrom({ sub: body.email, ws: body.workspace, role: body.role, iat: 0, exp: 9e9 }); // FORBIDDEN complete claims from a request body',
    'export const c = workspaceScopeFrom(newSessionClaims(body.email, body.workspace)); // FORBIDDEN unverified claims laundered through newSessionClaims',
    "export const d: WorkspaceScope = { workspaceSlug: body.workspace, actorEmail: body.email, role: 'owner' }; // FORBIDDEN the scope written out as an object literal",
    'export const e = async (): Promise<WorkspaceScope> => ({ ...(await legitimate()), workspaceSlug: body.workspace }); // FORBIDDEN a real scope spread and its tenant overwritten',
    'export const f = async (c: VerifiedSessionClaims): Promise<WorkspaceScope> => workspaceScopeFrom({ ...c, ws: body.workspace }); // FORBIDDEN real claims spread and their tenant overwritten',
    'export const g = async (c: VerifiedSessionClaims): Promise<WorkspaceScope> => new WorkspaceScope(c); // FORBIDDEN the constructor called directly',
    '',
    '// Escapes this task did not close at compile time. Each is a declared gap in the PR body,',
    '// and each is asserted here to compile clean so the declaration cannot quietly go stale.',
    'export const h = async (): Promise<WorkspaceScope> => Object.assign(await legitimate(), { workspaceSlug: body.workspace }); // DECLARED Object.assign onto a real scope: no diagnostic, and a TypeError at runtime because the scope is frozen',
    "export const i = async (): Promise<WorkspaceScope> => { const s = 'x'.repeat(32); const r = await verifySessionToken(await mintSessionToken(newSessionClaims(body.email, body.workspace), s), s); if (!r.ok) throw new Error(r.reason); return workspaceScopeFrom(r.claims); }; // DECLARED a token minted and verified with a secret the caller chose",
    '',
    '// The one way that is meant to work, so a fixture that fails everywhere fails this test.',
    'export async function legitimate(): Promise<WorkspaceScope> {',
    "  const result = await verifySessionToken('token', 'x'.repeat(32));",
    '  if (!result.ok) throw new Error(result.reason);',
    '  return workspaceScopeFrom(result.claims); // PERMITTED the only derivation there is',
    '}',
  ].join('\n');

  const fixtureConfig = (): string =>
    JSON.stringify(
      {
        extends: posix(path.join(repoRoot, 'tsconfig.json')),
        compilerOptions: { noEmit: true, types: ['node'] },
        files: ['./forgery.ts'],
      },
      null,
      2,
    );

  /**
   * Line numbers are read back out of the fixture, never written down here (W0-DOC-01).
   *
   * The tag is matched on a word boundary. This was first written as a substring search for the
   * tag followed by a space, which fails open: a forgery tagged `// FORBIDDEN` with no trailing
   * description would have matched nothing, generated no test, and gone unchecked — a line added
   * to close a hole quietly not closing it. ADR-0015, inside the gate written to enforce
   * ADR-0015. The assertion below refuses any line that mentions a tag it was not matched on.
   */
  const linesTagged = (tag: string): readonly number[] => {
    const marker = new RegExp(`//\\s*${tag}\\b`, 'u');
    return fixtureSource
      .split('\n')
      .map((line, index) => (marker.test(line) ? index + 1 : 0))
      .filter((lineNumber) => lineNumber > 0);
  };

  /** Every line that so much as mentions a tag must have been matched as carrying it. */
  const linesMentioning = (tag: string): readonly number[] =>
    fixtureSource
      .split('\n')
      .map((line, index) => (line.includes(tag) ? index + 1 : 0))
      .filter((lineNumber) => lineNumber > 0);

  let diagnostics: readonly { readonly line: number; readonly text: string }[] = [];
  let rawOutput = '';

  beforeAll(() => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(fixtureFile, fixtureSource, 'utf8');
    writeFileSync(path.join(fixtureDir, 'tsconfig.json'), fixtureConfig(), 'utf8');

    const tsc = path.join(repoRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
    if (!existsSync(tsc)) throw new Error('typescript is not installed — run `pnpm install`');
    try {
      rawOutput = execFileSync(process.execPath, [tsc, '-p', fixtureDir, '--pretty', 'false'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // A non-zero exit is the expected outcome; tsc writes its diagnostics to stdout.
      const failure = error as { stdout?: string; stderr?: string };
      rawOutput = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    const pattern = /^(?<file>.+?)\((?<line>\d+),\d+\): (?<text>error TS\d+: .*)$/u;
    diagnostics = rawOutput
      .split(/\r?\n/u)
      .map((line) => pattern.exec(line))
      .filter((match) => match !== null)
      .filter((match) => posix(match.groups?.['file'] ?? '').endsWith('forgery.ts'))
      .map((match) => ({
        line: Number(match.groups?.['line']),
        text: match.groups?.['text'] ?? '',
      }));
  }, 180_000);

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('has forgeries to reject, a legitimate derivation to admit and declared gaps to record', () => {
    expect(linesTagged('FORBIDDEN').length).toBeGreaterThan(0);
    expect(linesTagged('PERMITTED').length).toBeGreaterThan(0);
    expect(linesTagged('DECLARED').length).toBeGreaterThan(0);
    // And no line mentions a tag without being picked up as carrying it, so a mistagged forgery
    // fails this test instead of quietly generating no assertion.
    expect(linesTagged('FORBIDDEN')).toEqual(linesMentioning('FORBIDDEN'));
    expect(linesTagged('PERMITTED')).toEqual(linesMentioning('PERMITTED'));
    expect(linesTagged('DECLARED')).toEqual(linesMentioning('DECLARED'));
  });

  it.each(linesTagged('FORBIDDEN'))('rejects the forgery on fixture line %i', (line) => {
    const onThisLine = diagnostics.filter((diagnostic) => diagnostic.line === line);
    expect(
      onThisLine.length,
      `no compile error on fixture line ${String(line)}. tsc said:\n${rawOutput}`,
    ).toBeGreaterThan(0);
  });

  it.each(linesTagged('PERMITTED'))('admits the legitimate derivation on line %i', (line) => {
    expect(diagnostics.filter((diagnostic) => diagnostic.line === line)).toEqual([]);
  });

  it.each(linesTagged('DECLARED'))(
    'still compiles the declared escape on line %i, so the declared gap is not stale',
    (line) => {
      expect(
        diagnostics.filter((diagnostic) => diagnostic.line === line),
        `fixture line ${String(line)} is tagged DECLARED but the compiler now rejects it. That is ` +
          'good news: close the gap in the PR body and retag the line FORBIDDEN.',
      ).toEqual([]);
    },
  );

  it('reports nothing on any line that is not tagged FORBIDDEN', () => {
    const expected = new Set(linesTagged('FORBIDDEN'));
    const unexpected = diagnostics.filter((diagnostic) => !expected.has(diagnostic.line));
    // The explicit else. Without it a fixture that failed to parse would satisfy every
    // assertion above and this gate would pass while proving nothing (ADR-0015).
    expect(unexpected, `unexpected diagnostics:\n${rawOutput}`).toEqual([]);
  });
});
