/**
 * The SDK surface gate (plan §9.1, `sdk-surface test — pinned SDK options = R-01-options.json`).
 *
 * R-01 states this file's purpose in its own words: *"if it and the generator's output ever
 * disagree, the file is wrong"*, and *"the upgrade gate is `tests/sdk-surface.test.ts` diffing
 * the installed surface against `R-01-options.json`"*. The SDK is pre-1.0 and ships breaking
 * changes inside `0.3.x` patch releases, so the only thing standing between an upgrade and a
 * silent behaviour change in production is this test.
 *
 * ## Why it reads text instead of importing the SDK
 *
 * Two rules collide here and the collision is real:
 *
 *   * spec §42 — `apps/runner/src/claude.ts` is the ONLY file in the repository that may import
 *     `@anthropic-ai/claude-agent-sdk`;
 *   * this task — assert the **installed** SDK's option names and types.
 *
 * The reading taken is the one that keeps the §42 boundary meaningful: this file **reads the
 * shipped `sdk.d.ts` and `sdk.mjs` as text** and never imports, requires or executes the package,
 * so the assertions below are still made against the bytes that were installed rather than
 * against a transcription. See `docs/adr/W1-CORE-01-surface-test-reads-the-dts.md`.
 *
 * **§42 is not yet mechanically enforced, and this PR is the one that installs the SDK.** Plan
 * §9.1 lists a `no-sdk-import` test among the per-PR gates; §6.3's Wave 1 task table assigns it
 * to W1-RN-01 ("A unit test asserts no other file in the repo imports the SDK"), which has not
 * landed. Writing it here would take a file that belongs to a task above this one, so this branch
 * makes the boundary *checkable* — the dependency sits in `apps/runner`'s manifest and nothing in
 * `packages/core` imports it — and leaves the check itself to its owner. Anything on this branch
 * that reads as a claim that the boundary is gated today is wrong; it is upheld by construction
 * and by review until W1-RN-01 lands.
 *
 * ## What kind of evidence this produces
 *
 * Reading a shipped artefact is `verified (type contract)` for `sdk.d.ts` and `documented` for
 * `sdk.mjs`, in R-01's own legend — **not** `verified (probe — executed)`. Nothing here runs the
 * SDK, spawns the CLI, or reaches the network. Where that distinction matters most is the
 * `CLAUDE_CODE_PROJECT_DIR_NAME` block at the bottom: it establishes that the *shipped resolver*
 * has the two silent failure modes R-01 §7 describes, which is stronger than R-01's vendor-page
 * citation and still weaker than a live probe. It is declared that way on this task's PR.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';
import { describe, expect, it } from 'vitest';

import { AGENT_TOOL_PERMISSION_MODES } from '@indx-workspace/contracts/agents';

import { compiledSdkOptionKeys } from '@agent-workspace/engine-claude-agent-sdk';
import {
  sdkEventCarriesUsage,
  sdkEventTypes,
  sdkMessageTypeNames,
  sdkResultSubtypes,
  sdkSettingSources,
  sdkSystemSubtypes,
  validateTenantSessionScope,
} from '@agent-workspace/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The recorded contract. R-01 generated it; nothing in it is hand-written. */
const OPTIONS_JSON_PATH = path.join(REPO_ROOT, 'docs/research/R-01-options.json');
/** The generator that produced it, committed beside the note so this test need not restate it. */
const EXTRACTOR_PATH = path.join(REPO_ROOT, 'docs/research/fixtures/agent-sdk/extract-options.mjs');

/**
 * Where the pinned SDK is installed.
 *
 * `packages/engine-claude-agent-sdk` is the only workspace member that depends on it, because
 * spec §42 makes that package's `src/boundary.ts` the only importer — ENG-04 (#303) moved both
 * the dependency and the boundary out of `apps/runner`, and `tests/no-sdk-import.test.ts`'s
 * per-engine table is what asserts the pairing. The root is tried second so the gate keeps
 * working if a later wave hoists the dependency, and **not finding it is a failure** — a gate
 * that cannot run must fail, never skip (ADR-0015).
 */
const SDK_CANDIDATE_DIRS = [
  path.join(
    REPO_ROOT,
    'packages/engine-claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk',
  ),
  path.join(REPO_ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk'),
];

function resolveSdkDir(): string {
  for (const dir of SDK_CANDIDATE_DIRS) {
    if (existsSync(path.join(dir, 'sdk.d.ts'))) return dir;
  }
  throw new Error(
    `The pinned Agent SDK is not installed. Looked for sdk.d.ts under:\n  ${SDK_CANDIDATE_DIRS.join('\n  ')}\n` +
      'Run `pnpm install`. This gate asserts the INSTALLED surface; with nothing installed it has ' +
      'nothing to assert and must fail rather than pass quietly.',
  );
}

const sdkDir = resolveSdkDir();
const sdkDts = readFileSync(path.join(sdkDir, 'sdk.d.ts'), 'utf8');
const sdkMjs = readFileSync(path.join(sdkDir, 'sdk.mjs'), 'utf8');
const sdkPkg = JSON.parse(readFileSync(path.join(sdkDir, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  claudeCodeVersion?: string;
};

type OptionsContract = {
  package: string;
  version: string;
  claudeCodeVersion?: string;
  querySignature: string;
  optionCount: number;
  options: Record<string, { optional: boolean; type: string }>;
};
const contractText = readFileSync(OPTIONS_JSON_PATH, 'utf8');
const contract = JSON.parse(contractText) as OptionsContract;

describe('the installed SDK is the pinned one', () => {
  it('is the package R-01 recorded, at the exact recorded version', () => {
    expect(sdkPkg.name).toBe(contract.package);
    // An exact pin, not a range: R-01 §1 records that this SDK ships breaking changes inside
    // 0.3.x patch releases (0.3.142 removed the v2 session API; 0.2.113 changed `env` from
    // overlay to replace), so a caret range would take one silently.
    expect(sdkPkg.version).toBe(contract.version);
    expect(sdkPkg.claudeCodeVersion).toBe(contract.claudeCodeVersion);
  });

  it('is at or above the 0.3.234 floor that CLAUDE_CODE_PROJECT_DIR_NAME needs', () => {
    // R-01 §7: the tenant key override "Requires Agent SDK v0.3.234 or later" — a floor, not
    // just a pin. Compared numerically, because '0.3.99' > '0.3.234' as strings.
    const parts = sdkPkg.version.split('.').map((p) => Number.parseInt(p, 10));
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(Number.isInteger(part)).toBe(true);
    const [major, minor, patch] = parts as [number, number, number];
    expect(major).toBe(0);
    expect(minor).toBe(3);
    expect(patch).toBeGreaterThanOrEqual(234);
  });
});

describe('R-01-options.json still describes the installed SDK', () => {
  it('is byte-identical to what the committed generator produces from the installed sdk.d.ts', () => {
    // The strongest form of this assertion available: rather than re-implementing the parser
    // and risking a second parser that drifts, run the generator R-01 committed — the one that
    // produced the artefact — against the installed .d.ts, and compare the bytes. This is the
    // reproduction procedure docs/research/fixtures/agent-sdk/README.md documents, executed.
    const workDir = mkdtempSync(path.join(tmpdir(), 'sdk-surface-'));
    try {
      execFileSync(process.execPath, [EXTRACTOR_PATH], {
        cwd: workDir,
        env: {
          ...process.env,
          SDK_DTS: path.join(sdkDir, 'sdk.d.ts'),
          SDK_PKG: path.join(sdkDir, 'package.json'),
        },
        stdio: 'pipe',
      });
      const regenerated = readFileSync(path.join(workDir, 'options.json'), 'utf8');
      // On a mismatch the artefact is wrong, not the generator: nothing in options.json is
      // written by hand. Re-run the extractor and commit its output, then read the diff to see
      // what upstream changed.
      expect(regenerated).toBe(contractText);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('records the query() signature the installed sdk.d.ts declares', () => {
    // R-01's generator reads this rather than retyping it, because an earlier version hard-coded
    // `query(params: ...)` while the shipped declaration says `query(_params: ...)` and the two
    // drifted silently. Assert the recorded string is present in the file.
    const normalised = sdkDts.replace(/\s+/g, ' ');
    const expected = contract.querySignature.replace(/^function /, 'export declare function ');
    expect(normalised).toContain(expected);
  });
});

describe('every option the compile step can emit is a real Options key', () => {
  it('names only keys the installed SDK declares, with the recorded optionality', () => {
    // This is the assertion §42 costs us: packages/core cannot import `Options`, so nothing
    // type-checks `CompiledSdkOptions` against it. Here the two meet.
    expect(compiledSdkOptionKeys.length).toBeGreaterThan(0);
    const missing = compiledSdkOptionKeys.filter((key) => !(key in contract.options));
    expect(missing).toEqual([]);
    for (const key of compiledSdkOptionKeys) {
      const declared = contract.options[key];
      expect(declared, `${key} is absent from the recorded Options surface`).toBeDefined();
      // Every Options member is optional in the SDK; the compile step decides what to send.
      expect(declared?.optional, `${key} is no longer optional in Options`).toBe(true);
      // And the name is really in the shipped declaration, not only in the artefact.
      expect(sdkDts).toContain(`${key}?:`);
    }
  });

  it('emits the option names spec §5 and §6 assume, under those exact names', () => {
    // R-01's Decisions row: all thirteen exist unrenamed. Four of them are not emitted by the
    // compile step (`hooks`, `agents`, `sandbox`, `resume` on a fresh run), so they are checked
    // against the contract rather than against `compiledSdkOptionKeys`.
    for (const name of [
      'cwd',
      'model',
      'mcpServers',
      'skills',
      'allowedTools',
      'maxTurns',
      'maxBudgetUsd',
      'settingSources',
      'env',
      'resume',
      'sandbox',
      'hooks',
      'agents',
    ]) {
      expect(contract.options[name], `Options.${name} has been renamed or removed`).toBeDefined();
    }
  });

  it('still has the three restricting fields §6 omits (R-01 §10)', () => {
    // Spec §6 maps "Tool permissions -> allowedTools". R-01 established that `allowedTools`
    // only auto-approves. If any of these three ever disappears, the corrected model in
    // AgentToolPolicy stops being implementable and this test says so.
    for (const name of [
      'tools',
      'disallowedTools',
      'permissionMode',
      'allowDangerouslySkipPermissions',
    ]) {
      expect(contract.options[name], `Options.${name} has been renamed or removed`).toBeDefined();
    }
  });

  it('does not offer a projectKey option (R-01 §7)', () => {
    // The correction that matters most for multi-tenancy: there is no projectKey option, so any
    // future code that tries to set one is wrong. If the SDK ever adds one, this fails and the
    // env-var mechanism below should be revisited.
    expect(Object.keys(contract.options)).not.toContain('projectKey');
  });
});

/**
 * The `subtype` literals one declared message type accepts.
 *
 * Throws — rather than returning `[]` — when the declaration is not found or carries no
 * `subtype` member. An empty array would make the set comparison in the caller *smaller* and
 * could turn a missing declaration into a passing assertion, which is the failure ADR-0015
 * names: a check that could not run must not report a pass.
 *
 * The member is **parsed before it is compared**, and every alternative in the union must be a
 * quoted literal. An earlier revision matched literals with `/'([a-z_]+)'/g` and, because that
 * cannot match a name containing a digit, silently dropped any such alternative — the converse
 * gate below then passed over an upstream subtype it had never seen. Anything the parse does not
 * recognise is now an error, not a member quietly left out of the set.
 */
function subtypeLiterals(typeName: string): string[] {
  const marker = `export declare type ${typeName} = {`;
  const start = sdkDts.indexOf(marker);
  if (start < 0) throw new Error(`${typeName} is no longer declared as an object type`);
  const end = sdkDts.indexOf('\n};', start);
  if (end < 0) throw new Error(`${typeName}'s declaration does not terminate`);
  const body = sdkDts.slice(start, end);
  const member = /^\s*subtype:\s*([^;]+);/m.exec(body);
  if (member === null) throw new Error(`${typeName} declares no subtype member`);
  return stringLiteralUnion(`${typeName}.subtype`, member[1] ?? '');
}

/**
 * Every alternative of a TypeScript union of string literals, e.g. `'a' | 'b'`.
 *
 * Every alternative must be a single-quoted literal containing no quote. An alternative that is
 * anything else — a type reference, a template literal, `string` — throws, because the only other
 * thing this function could do is return a set that is quietly smaller than the declaration it
 * was asked to describe. That is the shape of the bug this file exists to catch.
 */
function stringLiteralUnion(what: string, source: string): string[] {
  const alternatives = source.split('|').map((alternative) => alternative.trim());
  const literals: string[] = [];
  for (const alternative of alternatives) {
    const literal = /^'([^']*)'$/.exec(alternative);
    if (literal === null) {
      throw new Error(
        `${what} declares ${JSON.stringify(alternative)}, which is not a string literal`,
      );
    }
    if (literal[1] === '') throw new Error(`${what} declares an empty string literal`);
    literals.push(literal[1] as string);
  }
  if (literals.length === 0) throw new Error(`${what} declares no literals`);
  return literals;
}

/**
 * The body of one `export declare type X = { ... }` block in `sdk.d.ts`.
 *
 * Returns `null` only for a name that is not declared as an object type — a union alias, say.
 * Callers must decide what that means for them; nothing here turns "not found" into "nothing to
 * check" on the caller's behalf (ADR-0015).
 */
function objectDeclarationBody(typeName: string): string | null {
  const marker = `export declare type ${typeName} = {`;
  const start = sdkDts.indexOf(marker);
  if (start < 0) return null;
  const end = sdkDts.indexOf('\n};', start);
  if (end < 0) throw new Error(`${typeName}'s declaration does not terminate`);
  return sdkDts.slice(start, end);
}

/**
 * Every leaf object type in the `SDKMessage` union, following one level of union aliasing
 * (`SDKResultMessage = SDKResultSuccess | SDKResultError`).
 *
 * Throws rather than returning `[]` at every step where the declaration could not be read. An
 * empty result would make the two assertions built on this — "which arms carry a cost" and "which
 * `type` discriminants exist" — vacuously true, which is exactly the fall-through ADR-0015 bans.
 */
function sdkMessageLeafTypes(): string[] {
  const union = /export declare type SDKMessage = ([^;]+);/.exec(sdkDts);
  if (union === null) throw new Error('SDKMessage is no longer declared as a union alias');
  const leaves: string[] = [];
  for (const member of (union[1] ?? '').split('|').map((m) => m.trim())) {
    if (member === '') throw new Error('SDKMessage declares an empty union member');
    if (objectDeclarationBody(member) !== null) {
      leaves.push(member);
      continue;
    }
    const alias = new RegExp(`export declare type ${member} = ([^;{]+);`).exec(sdkDts);
    if (alias === null) {
      throw new Error(`${member} is neither an object type nor a union alias in sdk.d.ts`);
    }
    for (const inner of (alias[1] ?? '').split('|').map((m) => m.trim())) {
      if (objectDeclarationBody(inner) === null) {
        throw new Error(`${member} resolves to ${inner}, which is not an object type`);
      }
      leaves.push(inner);
    }
  }
  if (leaves.length === 0) throw new Error('SDKMessage resolved to no leaf object types');
  return leaves;
}

/**
 * The `type` discriminant one leaf object type declares, or `null` if it declares no `type`
 * member at all.
 *
 * A `type` member that is present but is not a single string literal throws rather than reading
 * as "no discriminant": `null` here means *absent*, and callers treat absent as an error. Same
 * reasoning as {@link stringLiteralUnion} — the character class must not decide the answer.
 */
function typeDiscriminant(what: string, body: string): string | null {
  const member = /^\s*type:\s*([^;]+);/m.exec(body);
  if (member === null) return null;
  const literals = stringLiteralUnion(`${what}.type`, member[1] ?? '');
  if (literals.length !== 1) {
    throw new Error(`${what} declares ${literals.length} type discriminants; expected exactly one`);
  }
  return literals[0] as string;
}

describe('the event union transcribed into packages/core matches the shipped declaration', () => {
  it('declares every SDKMessage leaf type this platform names', () => {
    for (const name of sdkMessageTypeNames) {
      expect(sdkDts, `${name} is no longer declared`).toContain(`export declare type ${name} = `);
    }
  });

  it('declares every top-level type discriminant', () => {
    for (const type of sdkEventTypes) {
      expect(sdkDts, `no message declares type: '${type}'`).toContain(`type: '${type}'`);
    }
  });

  it('declares every system subtype', () => {
    for (const subtype of sdkSystemSubtypes) {
      expect(sdkDts, `no message declares subtype: '${subtype}'`).toContain(
        `subtype: '${subtype}'`,
      );
    }
  });

  it('declares no system subtype this platform has not transcribed', () => {
    // The converse of the assertion above, and the reason both are here. Checking only our
    // direction is a gate that passes when upstream ADDS a subtype — including to an existing
    // message type's union, where no new SDKMessage leaf appears for the member check below to
    // catch. That is a gate falling through to its pass path on new input (ADR-0015).
    //
    // The set is built by walking the union rather than by grepping `subtype: '...'` across the
    // file, so a subtype belonging to a non-system message cannot leak in.
    const upstream = new Set<string>();
    for (const leaf of sdkMessageLeafTypes()) {
      const body = objectDeclarationBody(leaf);
      if (body === null) throw new Error(`${leaf} lost its object declaration mid-run`);
      // An arm with no discriminant at all is an error, not a `continue`: skipping it would let
      // a system message whose `type` member upstream restructured drop out of the set unseen.
      const discriminant = typeDiscriminant(leaf, body);
      if (discriminant === null) throw new Error(`${leaf} declares no type discriminant`);
      if (discriminant !== 'system') continue;
      for (const subtype of subtypeLiterals(leaf)) upstream.add(subtype);
    }
    expect(
      upstream.size,
      'no system message declares a subtype — the walk found nothing',
    ).toBeGreaterThan(0);
    expect([...upstream].sort()).toEqual([...sdkSystemSubtypes].sort());
  });

  it('declares exactly the result subtypes transcribed here, across the success and error arms', () => {
    // The error arm declares its four subtypes as one union on a single member, so this reads
    // the literals out of the two declarations rather than searching for each spelling — which
    // would have quietly passed on a substring match elsewhere in a 412 KB file.
    const declared = new Set([
      ...subtypeLiterals('SDKResultSuccess'),
      ...subtypeLiterals('SDKResultError'),
    ]);
    expect([...declared].sort()).toEqual([...sdkResultSubtypes].sort());
  });

  it('has grown no top-level SDKMessage member this platform does not know about', () => {
    // The union is open in practice and the runner forwards unknown events opaquely, so a new
    // member is not a failure in production. It IS a signal that the transcription is behind,
    // which is what this gate exists to say out loud.
    const match = /export declare type SDKMessage = ([^;]+);/.exec(sdkDts);
    expect(match, 'SDKMessage is no longer declared as a union alias').not.toBeNull();
    const members = (match?.[1] ?? '').split('|').map((m) => m.trim());
    expect(members.length).toBeGreaterThan(0);
    const known = new Set<string>([...sdkMessageTypeNames, 'SDKResultMessage']);
    expect(members.filter((m) => !known.has(m))).toEqual([]);
  });

  it('puts total_cost_usd exactly where sdkEventCarriesUsage says it is', () => {
    // §35 records an estimated cost per run and `sdkEventCarriesUsage` is the predicate that
    // decides which event to read it off. The answer is derived from the installed sdk.d.ts here
    // rather than restated, so an upstream move of the field breaks this test instead of quietly
    // writing 0 into a billing row.
    const bearing = new Set<string>();
    const allDiscriminants = new Set<string>();
    for (const leaf of sdkMessageLeafTypes()) {
      const body = objectDeclarationBody(leaf);
      if (body === null) throw new Error(`${leaf} lost its object declaration mid-run`);
      const discriminant = typeDiscriminant(leaf, body);
      if (discriminant === null) throw new Error(`${leaf} declares no type discriminant`);
      allDiscriminants.add(discriminant);
      if (/^\s*total_cost_usd:/m.test(body)) bearing.add(discriminant);
    }
    expect(bearing.size, 'no SDKMessage arm declares total_cost_usd any more').toBeGreaterThan(0);

    // Every discriminant upstream declares, plus every one we transcribed, plus a name upstream
    // does not use: the predicate must answer for all of them, and `false` is the default only
    // because the .d.ts says so.
    const subjects = new Set([...allDiscriminants, ...sdkEventTypes, 'not_a_real_event_type']);
    for (const type of subjects) {
      expect(
        sdkEventCarriesUsage(type),
        `sdkEventCarriesUsage disagrees with sdk.d.ts on '${type}'`,
      ).toBe(bearing.has(type));
    }
  });

  it('declares PermissionMode and SettingSource exactly as transcribed', () => {
    expect(sdkDts).toContain(
      `export declare type PermissionMode = ${AGENT_TOOL_PERMISSION_MODES.map((m) => `'${m}'`).join(' | ')};`,
    );
    expect(sdkDts).toContain(
      `export declare type SettingSource = ${sdkSettingSources.map((s) => `'${s}'`).join(' | ')};`,
    );
  });
});

/**
 * R-01 §7 closes with an explicit instruction: *"Not probed: the 'invalid value falls back
 * silently' and 'ignored without `CLAUDE_CONFIG_DIR`' rules. … W1 should assert both in
 * `tests/sdk-surface.test.ts` before the tenant-isolation claim is called closed."*
 *
 * Both are asserted below against the resolver in the shipped `sdk.mjs`. That is one grade
 * stronger than R-01's vendor-page citation and one grade weaker than a live probe: it proves
 * the shipped code contains a resolver with those two properties, not that a running CLI
 * behaves that way. The live check remains open and is declared unverified on this task's PR.
 */
describe('the CLAUDE_CODE_PROJECT_DIR_NAME resolver still fails silently in both ways', () => {
  // The shape in the shipped bundle, with the two regex sources captured so the cases below can
  // be run against the SDK's own patterns rather than against our copy of them:
  //
  //   var A=/^[A-Za-z0-9_-]{1,64}$/,B=/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  //   function V(e){if(!e||!A.test(e)||B.test(e))return;return e}
  //
  // The pattern is deliberately exact and therefore brittle. That is the trade this whole file
  // makes: against a pinned version, a match that stops matching is the alarm, and re-reading
  // the resolver is the correct response to it.
  const VALIDATOR =
    /var (\w+)=\/(\^\[A-Za-z0-9_-\]\{1,64\}\$)\/,(\w+)=\/(\^\(\?:con\|prn\|aux\|nul\|com\[0-9\]\|lpt\[0-9\]\)\$)\/i;function (\w+)\(e\)\{if\(!e\|\|!\1\.test\(e\)\|\|\3\.test\(e\)\)return;return e\}/;

  const validatorMatch = VALIDATOR.exec(sdkMjs);

  it('ships the validator R-01 §7 quotes, and it returns rather than throws', () => {
    // The bare `return` in the matched body is the whole point: an invalid value produces
    // `undefined`, which the caller falls back from. Nothing throws, nothing is logged.
    expect(
      validatorMatch,
      'the CLAUDE_CODE_PROJECT_DIR_NAME validator is no longer in the shipped bundle in the shape R-01 recorded. ' +
        'Re-read the resolver before trusting the tenant key override.',
    ).not.toBeNull();
  });

  it('short-circuits on CLAUDE_CONFIG_DIR, so an unset config dir silently ignores the name', () => {
    const validatorName = validatorMatch?.[5];
    expect(validatorName).toBeTruthy();
    // `()=>CFG()?VALIDATE(NAME()):void 0` — the ternary IS failure mode 1. Minified identifiers
    // may contain `$`, which `\w` does not match, so the character class is spelled out.
    const resolver = new RegExp(
      `\\(\\)=>([\\w$]+)\\(\\)\\?${validatorName ?? ''}\\(([\\w$]+)\\(\\)\\):void 0`,
    );
    const resolverMatch = resolver.exec(sdkMjs);
    expect(
      resolverMatch,
      'the resolver is no longer gated on CLAUDE_CONFIG_DIR in the shape R-01 §7 rule 1 records',
    ).not.toBeNull();
    const configDirReader = resolverMatch?.[1] ?? '';
    const projectNameReader = resolverMatch?.[2] ?? '';
    expect(sdkMjs).toContain(`function ${configDirReader}(){return process.env.CLAUDE_CONFIG_DIR}`);
    expect(sdkMjs).toContain(
      `function ${projectNameReader}(){return process.env.CLAUDE_CODE_PROJECT_DIR_NAME}`,
    );
  });

  it("agrees with our validator on every case, using the SDK's own regexes", () => {
    // Rather than trusting the transcription in schemas.ts, rebuild the SDK's two patterns from
    // the source captured out of the bundle and require our verdict to match theirs, case by
    // case. If upstream loosens or tightens either rule, these two lines change with it and the
    // disagreement surfaces here instead of as a cross-tenant key collision in production.
    const nameSource = validatorMatch?.[2];
    const deviceSource = validatorMatch?.[4];
    expect(nameSource, 'the name pattern was not captured from the bundle').toBeTruthy();
    expect(deviceSource, 'the device-name pattern was not captured from the bundle').toBeTruthy();
    const namePattern = new RegExp(nameSource ?? '(?!)');
    const devicePattern = new RegExp(deviceSource ?? '(?!)', 'i');

    const cases = [
      'tenant-a',
      'a',
      'A_b-9',
      '0123456789012345678901234567890123456789012345678901234567890123',
      '01234567890123456789012345678901234567890123456789012345678901234',
      '',
      'tenant a',
      'tenant.a',
      'tenant/a',
      'con',
      'COM3',
      'lpt9',
      'nul',
      'console',
    ];
    for (const value of cases) {
      const sdkWouldAccept =
        Boolean(value) && namePattern.test(value) && !devicePattern.test(value);
      const verdict = validateTenantSessionScope({ projectKey: value, configDir: '/tmp/cfg' });
      expect(verdict.ok, `disagreement on ${JSON.stringify(value)}`).toBe(sdkWouldAccept);
    }
  });

  it('refuses a scope with no config dir, because the SDK would ignore the tenant key', () => {
    const verdict = validateTenantSessionScope({ projectKey: 'tenant-a', configDir: '' });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toContain('CLAUDE_CONFIG_DIR');
  });
});

/**
 * `tests/` is outside the repository's Prettier gate.
 *
 * Root `package.json`'s `format:check` globs are `apps/**`, `packages/**`, `scripts/**` and the
 * root `*.{json,mjs,ts}`. None of them match `tests/`, so this directory — created by this task —
 * would be the one place in the tree where formatting is unchecked. The root manifest belongs to
 * the wave's first task (ADR-0009 / ADR-0017), so the glob is not this task's to widen; the gate
 * is instead placed in a file this task owns, where it covers the same ground.
 *
 * It runs the same Prettier and the same `.prettierrc.json` that `pnpm format:check` runs, so
 * widening the glob later makes this redundant rather than contradictory.
 */
describe('tests/ is covered by a formatting gate', () => {
  function testSources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        found.push(...testSources(full));
      } else if (/\.(ts|mts|cts|json)$/.test(entry.name)) {
        found.push(full);
      }
    }
    return found;
  }

  const sources = testSources(path.join(REPO_ROOT, 'tests'));

  it('finds sources under tests/ to check', () => {
    // Without this the loop below is a no-op that reports green: an empty enumeration is the
    // classic ADR-0015 fall-through, and this directory can never legitimately be empty because
    // this very file lives in it.
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toContain(path.join(REPO_ROOT, 'tests', 'sdk-surface.test.ts'));
  });

  it('is Prettier-clean under the repository config', async () => {
    // Repeated rather than inherited from the assertion above: this `it` must fail on its own
    // when there is nothing to check, not rely on a sibling to have noticed (ADR-0015).
    expect(sources.length).toBeGreaterThan(0);
    // Every file is checked concurrently (the same files, the same verdict); Promise.all keeps the
    // input order, so the failure message is stable.
    const verdicts = await Promise.all(
      sources.map(async (file) => {
        const options = await prettier.resolveConfig(file);
        if (options === null) {
          throw new Error(`no Prettier config resolved for ${file}; the check could not run`);
        }
        const clean = await prettier.check(readFileSync(file, 'utf8'), {
          ...options,
          filepath: file,
        });
        return clean ? null : path.relative(REPO_ROOT, file);
      }),
    );
    const unformatted = verdicts.filter((file) => file !== null);
    expect(unformatted, 'run `npx prettier --write "tests/**"`').toEqual([]);
    // Every file under tests/ through Prettier: well past 5 s on a 2-vCPU CI runner.
  }, 60_000);
});
