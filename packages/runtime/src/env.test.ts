/**
 * `packages/runtime/src/env.test.ts` — this task's central gate.
 *
 * The naive version of this test is wrong in a way that cannot be fixed later: A.11's first
 * column is not a set of variable names. Nine rows, three shapes — seven hold one backticked
 * identifier, one holds two (`` `HTTP_PROXY` / `HTTPS_PROXY` ``), and one holds prose that is not
 * an identifier at all (`agent secrets`). A plain `Set` built by splitting every first cell on
 * commas would expect the literal string `"agent secrets"` as an environment key and fail for
 * every possible implementation. So `parseA11Table` below **partitions** the nine rows by what
 * the first cell actually *is* — `single` / `double` / `prose` — before anything is compared, and
 * ends in an explicit `else` that rejects a row matching none of the three shapes **by naming the
 * line number** (ADR-0015, ADR-0031). That rejection path is exercised for real below, against a
 * synthetic malformed table, not merely asserted to exist.
 *
 * The derived identifier set is then split by the *value* cell into unconditional and
 * conditional, and only the derived result — never a hand-typed list — is compared against
 * `buildRuntimeEnvironment`'s own declared constants and its actual emitted output. ADR-0016: a
 * count is generated, not transcribed; W3-RT-01's round 1 finding is the reason this file derives
 * rather than hardcodes.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  A11_CONDITIONAL_ENV_VARS,
  A11_UNCONDITIONAL_ENV_VARS,
  buildRuntimeEnvironment,
  CREDENTIAL_SECRET_NAME_SUFFIXES,
  sessionWorkspacePaths,
  type RuntimeEnvironmentInput,
} from './env.js';
import { createLocalDriver } from './local.js';
import type { AgentConnection, RuntimeCapabilities, RuntimeHandle } from './driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs/spec.md');

// ── §1: read and partition A.11's table out of docs/spec.md ────────────────────────────────

type A11Row =
  | {
      readonly kind: 'single';
      readonly name: string;
      readonly value: string;
      readonly line: number;
    }
  | {
      readonly kind: 'double';
      readonly names: readonly [string, string];
      readonly value: string;
      readonly line: number;
    }
  | {
      readonly kind: 'prose';
      readonly text: string;
      readonly value: string;
      readonly line: number;
    };

const SINGLE_IDENTIFIER = /^`([A-Za-z0-9_]+)`$/;
const DOUBLE_IDENTIFIER = /^`([A-Za-z0-9_]+)`\s*\/\s*`([A-Za-z0-9_]+)`$/;

/**
 * Split one markdown table row on `|`, trimming the leading/trailing empty cells GFM's own
 * `| a | b |` syntax produces. None of A.11's cells contain an escaped or literal pipe, so a
 * plain split is exact here — unlike the cross-wave-dependencies table
 * the Wave 3 plan's own "What this plan corrects" section names as a defect elsewhere,
 * this table has no code-span pipes to trip over.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutEdges.split('|').map((cell) => cell.trim());
}

/**
 * Parse the markdown table directly under the `## A.11 Environment contract for every runtime`
 * heading, one {@link A11Row} per data row (header and separator rows excluded).
 *
 * ADR-0015's `else`: a row whose first cell is neither a single identifier, a `a` / `b` pair of
 * identifiers, nor prose containing no backtick at all, is rejected **by naming the line number**
 * — never silently skipped and never coerced into one of the three shapes.
 */
function parseA11Table(specText: string): A11Row[] {
  const lines = specText.split(/\r?\n/);
  const headingIndex = lines.findIndex(
    (line) => line.trim() === '## A.11 Environment contract for every runtime',
  );
  if (headingIndex === -1) {
    throw new Error(
      `parseA11Table: docs/spec.md has no "## A.11 Environment contract for every runtime" heading; the section may have been renamed.`,
    );
  }
  // The table starts at the first line after the heading that begins with "|" and ends at the
  // first line after that which does not (a blank line closes every markdown table).
  let tableStart = -1;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim().startsWith('|')) {
      tableStart = i;
      break;
    }
  }
  if (tableStart === -1) {
    throw new Error(
      `parseA11Table: found the A.11 heading at docs/spec.md:${String(headingIndex + 1)} but no table under it.`,
    );
  }
  let tableEnd = lines.length;
  for (let i = tableStart; i < lines.length; i += 1) {
    if (!(lines[i] ?? '').trim().startsWith('|')) {
      tableEnd = i;
      break;
    }
  }
  // Row 0 is the header (`| Variable | Value |`), row 1 the `---` separator. Data starts at 2.
  const dataLines = lines.slice(tableStart + 2, tableEnd);
  const rows: A11Row[] = [];
  for (let offset = 0; offset < dataLines.length; offset += 1) {
    const lineNumber = tableStart + 2 + offset + 1; // 1-indexed, matching editor line numbers
    const [firstCellRaw, valueRaw] = splitRow(dataLines[offset] ?? '');
    const firstCell = firstCellRaw ?? '';
    const value = valueRaw ?? '';

    const doubleMatch = DOUBLE_IDENTIFIER.exec(firstCell);
    if (doubleMatch && doubleMatch[1] !== undefined && doubleMatch[2] !== undefined) {
      rows.push({
        kind: 'double',
        names: [doubleMatch[1], doubleMatch[2]],
        value,
        line: lineNumber,
      });
      continue;
    }
    const singleMatch = SINGLE_IDENTIFIER.exec(firstCell);
    if (singleMatch && singleMatch[1] !== undefined) {
      rows.push({ kind: 'single', name: singleMatch[1], value, line: lineNumber });
      continue;
    }
    if (!firstCell.includes('`') && firstCell.length > 0) {
      rows.push({ kind: 'prose', text: firstCell, value, line: lineNumber });
      continue;
    }
    // The ADR-0015 `else`: neither shape matched, and it is not the known prose row either.
    // Reject by name — never fall through to any of the three arms above.
    throw new Error(
      `parseA11Table: docs/spec.md:${String(lineNumber)} does not parse as a single identifier, a pair of identifiers, or plain prose: ${JSON.stringify(firstCell)}.`,
    );
  }
  return rows;
}

const specText = readFileSync(SPEC_PATH, 'utf8');

describe('A.11 table partition (docs/spec.md), derived — not a hand-typed list', () => {
  const rows = parseA11Table(specText);
  const singles = rows.filter((row) => row.kind === 'single');
  const doubles = rows.filter((row) => row.kind === 'double');
  const prose = rows.filter((row) => row.kind === 'prose');

  it('has exactly nine rows, partitioned seven / one / one by shape', () => {
    expect(rows).toHaveLength(9);
    expect(singles).toHaveLength(7);
    expect(doubles).toHaveLength(1);
    expect(prose).toHaveLength(1);
  });

  it('the double row is exactly HTTP_PROXY / HTTPS_PROXY', () => {
    expect(doubles[0]).toMatchObject({ names: ['HTTP_PROXY', 'HTTPS_PROXY'] });
  });

  it('the prose row is exactly "agent secrets", asserted separately and never as a key', () => {
    expect(prose[0]).toMatchObject({ text: 'agent secrets' });
  });

  // §23's row is prose, so it contributes zero identifiers to the derived set below — asserted
  // by construction (it is filtered out), not by a second, separate check.
  const derivedNames = [
    ...singles.map((row) => (row.kind === 'single' ? row.name : '')),
    ...doubles.flatMap((row) => (row.kind === 'double' ? row.names : [])),
  ];

  it('derives nine distinct variable names from the eight identifier-bearing rows', () => {
    expect(new Set(derivedNames).size).toBe(9);
    expect(derivedNames).toHaveLength(9);
  });

  // A row's condition is read off its own Value cell, never off which variable it happens to
  // name: "only when" / "on Node" / "optional" are A.11's own conditional phrasings, and a row
  // whose value carries none of them is unconditional. This is the "split the eight names by the
  // value cell" step the plan cell asks for, computed from the cell text rather than an
  // assumption about which names are which.
  function isConditional(value: string): boolean {
    return /only when|on Node|optional/i.test(value);
  }

  const derivedUnconditional = new Set<string>();
  const derivedConditional = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'single') {
      (isConditional(row.value) ? derivedConditional : derivedUnconditional).add(row.name);
    } else if (row.kind === 'double') {
      for (const name of row.names) {
        (isConditional(row.value) ? derivedConditional : derivedUnconditional).add(name);
      }
    }
  }

  it('derives exactly the five unconditional names the plan cell states', () => {
    expect(derivedUnconditional).toEqual(new Set(A11_UNCONDITIONAL_ENV_VARS));
  });

  it('derives exactly the four conditional names the plan cell states', () => {
    expect(derivedConditional).toEqual(new Set(A11_CONDITIONAL_ENV_VARS));
  });

  it('rejects a row that parses as neither shape, naming the line number (ADR-0015 else)', () => {
    const malformed = [
      '## A.11 Environment contract for every runtime',
      '',
      '| Variable | Value |',
      '| --- | --- |',
      '| `GOOD_ONE` | always set |',
      '| `A`, `B`, `C` | not a shape this parser accepts |',
      '',
    ].join('\n');
    expect(() => parseA11Table(malformed)).toThrow(/docs\/spec\.md:6/);
  });

  it('rejects a first cell that carries a stray backtick and is not the known prose row', () => {
    const malformed = [
      '## A.11 Environment contract for every runtime',
      '',
      '| Variable | Value |',
      '| --- | --- |',
      '| something with a lone ` backtick | x |',
      '',
    ].join('\n');
    expect(() => parseA11Table(malformed)).toThrow(/docs\/spec\.md:5/);
  });

  it('refuses to run at all if the A.11 heading has been renamed or removed', () => {
    expect(() => parseA11Table('# nothing relevant here')).toThrow(/no "## A\.11/);
  });
});

// ── §2: buildRuntimeEnvironment itself ──────────────────────────────────────────────────────

const baseInput: RuntimeEnvironmentInput = {
  gatewayBaseUrl: 'https://gateway.internal.example/v1',
  authToken: 'run-token-aaa',
  configDir: '/sandbox/session-a/.claude',
  runId: 'run-aaa',
  sessionId: 'session-aaa',
  nodeMajorVersion: 20, // sub-24: drives the NODE_USE_ENV_PROXY-absent branch by default
  networkPolicy: 'open',
};

describe('buildRuntimeEnvironment — the emitted key set equals the derived set, exactly', () => {
  it('emits exactly the five unconditional keys when no condition holds', () => {
    const env = buildRuntimeEnvironment(baseInput);
    expect(Object.keys(env).sort()).toEqual([...A11_UNCONDITIONAL_ENV_VARS].sort());
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: baseInput.gatewayBaseUrl,
      ANTHROPIC_AUTH_TOKEN: baseInput.authToken,
      CLAUDE_CONFIG_DIR: baseInput.configDir,
      AGENT_WORKSPACE_RUN_ID: baseInput.runId,
      AGENT_WORKSPACE_SESSION_ID: baseInput.sessionId,
    });
  });

  it('drives both branches of the Node version condition', () => {
    const sub24 = buildRuntimeEnvironment({ ...baseInput, nodeMajorVersion: 23 });
    expect(sub24['NODE_USE_ENV_PROXY']).toBeUndefined();

    const at24 = buildRuntimeEnvironment({ ...baseInput, nodeMajorVersion: 24 });
    expect(at24['NODE_USE_ENV_PROXY']).toBe('1');

    const above24 = buildRuntimeEnvironment({ ...baseInput, nodeMajorVersion: 25 });
    expect(above24['NODE_USE_ENV_PROXY']).toBe('1');
  });

  it("defaults nodeMajorVersion to this process's own — asserted against a real probe, not assumed", () => {
    // This task's plan cell records `node -v` → `v24.19.0` on the machine it was written on.
    // Rather than transcribe that number (ADR-0016), read it from the running process.
    // `Number.parseInt`, not `.split('.')` — see env.ts's `currentNodeMajorVersion` for why.
    const thisMajor = Number.parseInt(process.versions.node, 10);
    const { nodeMajorVersion: _drop, ...withoutVersion } = baseInput;
    void _drop;
    const env = buildRuntimeEnvironment(withoutVersion);
    expect(env['NODE_USE_ENV_PROXY']).toBe(thisMajor >= 24 ? '1' : undefined);
  });

  it('emits HTTP_PROXY and HTTPS_PROXY together, for restricted and open with a configured proxy', () => {
    // ADR-0117 decision 8: `open` is the public internet *through* the proxy, so it is proxied too.
    for (const networkPolicy of ['restricted', 'open'] as const) {
      const withProxy = buildRuntimeEnvironment({
        ...baseInput,
        networkPolicy,
        proxyUrl: 'http://proxy.internal.example:3128',
      });
      expect(withProxy['HTTP_PROXY']).toBe('http://proxy.internal.example:3128');
      expect(withProxy['HTTPS_PROXY']).toBe('http://proxy.internal.example:3128');

      const withoutProxy = buildRuntimeEnvironment({ ...baseInput, networkPolicy });
      expect(withoutProxy['HTTP_PROXY']).toBeUndefined();
      expect(withoutProxy['HTTPS_PROXY']).toBeUndefined();
    }

    // The condition is the policy, not merely "a proxyUrl was supplied": `none` must ignore one
    // even if a caller passed it, which an implementation keyed only on `proxyUrl` would not.
    const none = buildRuntimeEnvironment({
      ...baseInput,
      networkPolicy: 'none',
      proxyUrl: 'http://proxy.internal.example:3128',
    });
    expect(none['HTTP_PROXY']).toBeUndefined();
    expect(none['HTTPS_PROXY']).toBeUndefined();
  });

  it('emits OTEL_EXPORTER_OTLP_ENDPOINT only when a collector is configured', () => {
    const withCollector = buildRuntimeEnvironment({
      ...baseInput,
      otelExporterOtlpEndpoint: 'http://otel-collector.internal.example:4318',
    });
    expect(withCollector['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe(
      'http://otel-collector.internal.example:4318',
    );
    expect(buildRuntimeEnvironment(baseInput)['OTEL_EXPORTER_OTLP_ENDPOINT']).toBeUndefined();
  });

  it('emits exactly all nine derived keys when every condition holds', () => {
    const env = buildRuntimeEnvironment({
      ...baseInput,
      nodeMajorVersion: 24,
      networkPolicy: 'restricted',
      proxyUrl: 'http://proxy.internal.example:3128',
      otelExporterOtlpEndpoint: 'http://otel-collector.internal.example:4318',
    });
    expect(Object.keys(env).sort()).toEqual(
      [...A11_UNCONDITIONAL_ENV_VARS, ...A11_CONDITIONAL_ENV_VARS].sort(),
    );
  });

  it('ANTHROPIC_AUTH_TOKEN is run-scoped: two runs, two tokens, never a shared constant', () => {
    const runA = buildRuntimeEnvironment({ ...baseInput, runId: 'run-a', authToken: 'token-a' });
    const runB = buildRuntimeEnvironment({ ...baseInput, runId: 'run-b', authToken: 'token-b' });
    expect(runA['ANTHROPIC_AUTH_TOKEN']).toBe('token-a');
    expect(runB['ANTHROPIC_AUTH_TOKEN']).toBe('token-b');
    expect(runA['ANTHROPIC_AUTH_TOKEN']).not.toBe(runB['ANTHROPIC_AUTH_TOKEN']);
  });

  it('ANTHROPIC_API_KEY is asserted absent — never a key, under any input', () => {
    const env = buildRuntimeEnvironment(baseInput);
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    // The attempted-smuggling path: a secret assigned to the agent that happens to be named the
    // provider master credential must be refused outright, not merged in.
    expect(() =>
      buildRuntimeEnvironment({ ...baseInput, secrets: { ANTHROPIC_API_KEY: 'sk-ant-stolen' } }),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(() =>
      buildRuntimeEnvironment({ ...baseInput, secrets: { anthropic_api_key: 'sk-ant-stolen' } }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('refuses a credential-shaped agent secret name, which every engine would refuse to run', () => {
    for (const name of ['OPENAI_API_KEY', 'stripe_api_key', 'GITHUB_AUTH_TOKEN']) {
      expect(() =>
        buildRuntimeEnvironment({ ...baseInput, secrets: { [name]: 'a-real-secret' } }),
      ).toThrow(/spelled like a credential/);
    }
    // A secret that is not credential-shaped is still emitted unchanged.
    const env = buildRuntimeEnvironment({ ...baseInput, secrets: { GITHUB_TOKEN: 'ghp_x' } });
    expect(env['GITHUB_TOKEN']).toBe('ghp_x');
  });

  it("restates the engine port's credential suffixes exactly", () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../engine/src/sandbox-env.ts', import.meta.url)),
      'utf8',
    );
    const match = /CREDENTIAL_ENV_SUFFIXES = \[([^\]]*)\] as const/u.exec(source);
    expect(match).not.toBeNull();
    const suffixes = [...(match?.[1] ?? '').matchAll(/'([^']+)'/gu)].map((found) => found[1]);
    expect(suffixes).toEqual([...CREDENTIAL_SECRET_NAME_SUFFIXES]);
  });

  it('refuses a secret whose name collides with a reserved A.11 key', () => {
    expect(() =>
      buildRuntimeEnvironment({ ...baseInput, secrets: { CLAUDE_CONFIG_DIR: '/elsewhere' } }),
    ).toThrow(/reserved/);
    expect(() =>
      buildRuntimeEnvironment({ ...baseInput, secrets: { claude_config_dir: '/elsewhere' } }),
    ).toThrow(/reserved/);
  });

  it('refuses duplicate agent secret names under case-insensitive Windows semantics', () => {
    expect(() =>
      buildRuntimeEnvironment({
        ...baseInput,
        secrets: { GITHUB_TOKEN: 'first', github_token: 'second' },
      }),
    ).toThrow(/duplicate agent secret name/u);
  });

  it('emits an own __proto__ environment entry without prototype mutation', () => {
    const secrets = JSON.parse('{"__proto__":"prototype-secret"}') as Record<string, string>;
    const env = buildRuntimeEnvironment({ ...baseInput, secrets });
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(env, '__proto__')).toBe(true);
    expect(env['__proto__']).toBe('prototype-secret');

    const observed = execFileSync(
      process.execPath,
      [
        '-e',
        "const key=Object.keys(process.env).find((name)=>name==='__proto__'); process.stdout.write(JSON.stringify(key && process.env[key]));",
      ],
      { env, encoding: 'utf8' },
    );
    expect(JSON.parse(observed)).toBe('prototype-secret');
  });

  it('two agents, two different secrets: diffing the two emitted environments isolates exactly the secrets', () => {
    const agentA = buildRuntimeEnvironment({
      ...baseInput,
      secrets: { GITHUB_TOKEN: 'gh-a', JIRA_TOKEN: 'jira-a' },
    });
    const agentB = buildRuntimeEnvironment({
      ...baseInput,
      secrets: { STRIPE_KEY: 'sk-b' },
    });
    const onlyInA = Object.keys(agentA).filter((key) => !(key in agentB));
    const onlyInB = Object.keys(agentB).filter((key) => !(key in agentA));
    expect(onlyInA.sort()).toEqual(['GITHUB_TOKEN', 'JIRA_TOKEN']);
    expect(onlyInB.sort()).toEqual(['STRIPE_KEY']);
    // Everything else — the five unconditional keys — is identical between the two, because
    // nothing about which agent it is changes them.
    for (const key of A11_UNCONDITIONAL_ENV_VARS) {
      expect(agentA[key]).toBe(agentB[key]);
    }
  });

  it('rejects malformed input by name (ADR-0015): missing fields, bad networkPolicy', () => {
    expect(() => buildRuntimeEnvironment({ ...baseInput, gatewayBaseUrl: '' })).toThrow(
      /gatewayBaseUrl/,
    );
    expect(() =>
      buildRuntimeEnvironment({
        ...baseInput,
        networkPolicy: 'bogus' as unknown as RuntimeEnvironmentInput['networkPolicy'],
      }),
    ).toThrow(/networkPolicy/);
  });
});

// ── §3: sessionWorkspacePaths — §25's distinct cwd / CLAUDE_CONFIG_DIR per session ──────────

/**
 * The engine configuration directory these cases pass in.
 *
 * A parameter since ENG-04b (#325): the directory is the *engine's* answer
 * (`AgentEngine.protectedConfigDirectory`), and this package may not import an adapter to ask. The
 * value here is the Claude Agent SDK's, which is what every caller passed implicitly before.
 */
const CONFIG_DIRECTORY = '.claude';

describe('sessionWorkspacePaths — §25 isolation, proven on distinct values, not read off the code', () => {
  it('two sessions under one workspace root get two distinct cwds and configDirs', () => {
    const a = sessionWorkspacePaths('/workspace/agent-1', 'session-aaa', CONFIG_DIRECTORY);
    const b = sessionWorkspacePaths('/workspace/agent-1', 'session-bbb', CONFIG_DIRECTORY);
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.configDir).not.toBe(b.configDir);
    expect(a.configDir.startsWith(a.cwd)).toBe(true);
    expect(b.configDir.startsWith(b.cwd)).toBe(true);
  });

  it('refuses a session id shaped like a path-traversal, an absolute path, or empty', () => {
    for (const bad of ['../escape', '..', '/etc/passwd', 'C:\\Windows', '', 'a/b', 'a b']) {
      expect(() => sessionWorkspacePaths('/workspace/agent-1', bad, CONFIG_DIRECTORY)).toThrow(
        /sessionWorkspacePaths/,
      );
    }
  });

  it('nests the engine configuration directory the caller named, and refuses one that is a path', () => {
    expect(
      sessionWorkspacePaths('/workspace/agent-1', 'session-aaa', CONFIG_DIRECTORY).configDir,
    ).toBe('/workspace/agent-1/session-aaa/.claude');
    // A second engine's directory, to prove the name is not this package's decision.
    expect(
      sessionWorkspacePaths('/workspace/agent-1', 'session-aaa', '.openai-agents').configDir,
    ).toBe('/workspace/agent-1/session-aaa/.openai-agents');
    for (const bad of ['', 'a/b', 'a\\b', '..']) {
      expect(() => sessionWorkspacePaths('/workspace/agent-1', 'session-aaa', bad)).toThrow(
        /protectedConfigDirectory/,
      );
    }
  });
});

// ── §4: A.12 scenario 10, run against `local` — the value asserted on must cross the boundary
// the scenario is about, never a value the test manufactured (ADR-0046), and the precondition the
// verdict depends on must be one the probe ITSELF establishes, never one the host happens to
// provide (ADR-0047) ─────────────────────────────────────────────────────────────────────────

/**
 * A driver-agnostic "agent": a Node subprocess that reports exactly what IT can see, as JSON on
 * stdout. This is not the Claude Agent SDK (there is no model credential in this deployment; see
 * this task's declared gaps), but it answers A.12 scenario 10's actual question — *"is host
 * configuration visible inside the sandbox?"* — by literally running a process with the injected
 * `cwd` and `env` and reading back what THAT process observed, which no amount of reading
 * `local.ts`'s source could establish.
 *
 * Round 1's version of this probe reported `CLAUDE_CONFIG_DIR`'s own contents — a directory this
 * test had just `mkdirSync`'d moments earlier, so it was empty by construction and the assertion
 * built on it could not fail for any driver on earth (ADR-0046). Round 2's repair read the REAL
 * host `~/.claude` instead — correct in shape, but the verdict it fed depended on whatever this
 * particular host happened to have there, so it passed vacuously on any CI runner (ADR-0047,
 * found independently on two branches, two rounds running). Neither the empty directory nor the
 * host's real one is a precondition the probe controls, so this version manufactures its own: a
 * throwaway `hostConfigRoot` this test creates and destroys, seeded with a marker only the
 * harness could have written, standing in for "the host's configuration root" for the run —
 * never the real `$HOME`/`USERPROFILE` (a probe must not write into the operator's own
 * configuration; ADR-0047). The probe reports whether it can read that marker back through
 * `os.homedir()`, plus — restoring the end-to-end proof round 2 silently dropped, see this
 * round's frozen findings — whether `process.env.CLAUDE_CONFIG_DIR`, exactly as
 * `buildRuntimeEnvironment` computed it, actually reached this process and names a real,
 * readable directory.
 */
function runProbe(
  cwd: string,
  env: Record<string, string>,
): {
  cwd: string;
  sandboxHomedir: string;
  hostConfigMarker: string | null;
  envConfigDir: string | null;
  envConfigDirEntries: string[] | null;
} {
  const script =
    "const fs=require('fs');const os=require('os');const path=require('path');" +
    'let hostConfigMarker;' +
    "try { hostConfigMarker = fs.readFileSync(path.join(os.homedir(), '.claude', 'HOST-MARKER'), 'utf8'); } " +
    'catch (err) { hostConfigMarker = null; }' +
    'let envConfigDirEntries;' +
    'try { envConfigDirEntries = fs.readdirSync(process.env.CLAUDE_CONFIG_DIR); } ' +
    'catch (err) { envConfigDirEntries = null; }' +
    'process.stdout.write(JSON.stringify({' +
    'cwd: process.cwd(), sandboxHomedir: os.homedir(), ' +
    'hostConfigMarker: hostConfigMarker, envConfigDir: process.env.CLAUDE_CONFIG_DIR || null, ' +
    'envConfigDirEntries: envConfigDirEntries' +
    '}));';
  const stdout = execFileSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8' });
  return JSON.parse(stdout) as {
    cwd: string;
    sandboxHomedir: string;
    hostConfigMarker: string | null;
    envConfigDir: string | null;
    envConfigDirEntries: string[] | null;
  };
}

/**
 * A.12 scenario 10's verdict, as a pure function of what actually crossed the boundary —
 * `hostConfigReachable` — and what the driver's OWN `RuntimeCapabilities` says about itself.
 * Never a value this file fabricates; ADR-0046 rule 1.
 *
 * A.12: *"A driver that cannot pass a scenario declares it unsupported in `RuntimeCapabilities`;
 * it must never pass by weakening the test."* `isolation: 'none'` IS that declaration, so it is
 * consulted FIRST, before `hostConfigReachable` — not after. Round 2's version tested
 * reachability first and fell through to the capability only when something was actually found
 * reachable; on a host with nothing to find (any CI runner, since `local` never leaked the
 * synthetic host root that round 2 didn't yet seed) that produced a silent `pass` for a driver
 * with no sandbox boundary at all — the exact defect ADR-0047 records. Ordering the capability
 * check first makes `isolation: 'none'` incapable of ever reaching `pass`, regardless of what any
 * particular run happens to observe: `scenario10Verdict(true, 'none')` and
 * `scenario10Verdict(false, 'none')` both below give the same answer, which is the property a
 * driver's own declared capability is supposed to guarantee. A driver that leaks while claiming
 * real isolation still gets the harsher verdict: `fail`.
 */
function scenario10Verdict(
  hostConfigReachable: boolean,
  isolation: RuntimeCapabilities['isolation'],
): 'pass' | 'fail' | 'unsupported-by-capability' {
  if (isolation === 'none') return 'unsupported-by-capability';
  return hostConfigReachable ? 'fail' : 'pass';
}

describe('A.12 scenario 10 against `local`: no host configuration is visible inside the sandbox', () => {
  it('local leaks a harness-seeded host-config marker (ADR-0047) and the injected env reaches the process (ADR-0046 rule 1), so `local` is unsupported-by-capability on every host, including one with no real ~/.claude', async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'w3-cp-09-a12-10-'));
    // ADR-0047: the probe establishes its own precondition instead of reading one the host
    // happens to provide. `hostConfigRoot` is this run's OWN stand-in for "the host's
    // configuration root" — created fresh here, seeded with a marker only this test process could
    // have written, and destroyed in `finally` below. It is never the real `$HOME` /
    // `process.env.USERPROFILE`: a probe must not write into the operator's own configuration,
    // and a scenario that only works on a machine that already has one is the defect being
    // repaired. Because the harness wrote the marker, a read of it is always meaningful — on a
    // laptop with a real `~/.claude` and on a CI runner with none, identically.
    const hostConfigRoot = mkdtempSync(path.join(tmpdir(), 'w3-cp-09-a12-10-hostroot-'));
    const hostClaudeDir = path.join(hostConfigRoot, '.claude');
    mkdirSync(hostClaudeDir, { recursive: true });
    const hostMarkerToken = `host-marker-${randomUUID()}`;
    writeFileSync(path.join(hostClaudeDir, 'HOST-MARKER'), hostMarkerToken, 'utf8');
    try {
      const driver = createLocalDriver<
        { cwd: string; env: Record<string, string> },
        {
          cwd: string;
          sandboxHomedir: string;
          hostConfigMarker: string | null;
          envConfigDir: string | null;
          envConfigDirEntries: string[] | null;
        }
      >(
        (
          _runtime: RuntimeHandle,
          request,
        ): AgentConnection<{
          cwd: string;
          sandboxHomedir: string;
          hostConfigMarker: string | null;
          envConfigDir: string | null;
          envConfigDirEntries: string[] | null;
        }> => {
          const result = runProbe(request.cwd, request.env);
          return {
            events: (async function* () {
              await Promise.resolve();
              yield result;
            })(),
            sessionId: Promise.resolve('probe-session'),
            interrupt: () => Promise.resolve(),
          };
        },
      );

      const sessionIds = ['session-one', 'session-two'] as const;
      const scopes = sessionIds.map((sessionId) =>
        sessionWorkspacePaths(workspaceRoot, sessionId, CONFIG_DIRECTORY),
      );

      // Distinctness is a property of sessionWorkspacePaths already proven above; A.12 scenario
      // 10 additionally needs the directories to actually exist before anything runs in them —
      // the same responsibility `apps/runner/src/index.ts`'s `startAgentInThisContainer`
      // discharges for the real pipeline (mkdir, not mkdtemp, so a second run against the same
      // session reuses rather than fails, matching `local`'s own `persistentFilesystem: true`).
      const [scopeOne, scopeTwo] = scopes;
      if (scopeOne === undefined || scopeTwo === undefined) {
        throw new Error('test setup error: expected exactly two session scopes.');
      }
      for (const scope of [scopeOne, scopeTwo]) {
        mkdirSync(scope.cwd, { recursive: true });
        mkdirSync(scope.configDir, { recursive: true });
      }

      const results: {
        cwd: string;
        sandboxHomedir: string;
        hostConfigMarker: string | null;
        envConfigDir: string | null;
        envConfigDirEntries: string[] | null;
      }[] = [];
      for (const [index, sessionId] of sessionIds.entries()) {
        const scope = index === 0 ? scopeOne : scopeTwo;
        const handle = await driver.create({
          engine: 'claude-agent-sdk',
          sessionId,
          workspacePath: scope.cwd,
        });
        const env: Record<string, string> = {
          ...buildRuntimeEnvironment({
            ...baseInput,
            runId: `run-${sessionId}`,
            sessionId,
            configDir: scope.configDir,
          }),
          // The harness's designation of "this run's host configuration root" (ADR-0047). Never
          // emitted by `buildRuntimeEnvironment` itself — A.11 does not name HOME/USERPROFILE as
          // a key that injector owns — so the test sets it directly, exactly as an operator's
          // real shell environment would arrive at a driver that does no isolation. `local` has
          // no sandbox boundary to strip or rewrite this with, which is what `isolation: 'none'`
          // means; a driver with a real sandbox would run its child in its own namespace/image
          // where this same value resolves to nothing reachable.
          HOME: hostConfigRoot,
          USERPROFILE: hostConfigRoot,
        };
        const connection = await driver.startAgent(handle, { cwd: scope.cwd, env });
        for await (const event of connection.events) {
          results.push(event);
        }
      }

      expect(results).toHaveLength(2);
      const [resultOne, resultTwo] = results;
      if (resultOne === undefined || resultTwo === undefined) {
        throw new Error('test setup error: expected exactly two probe results.');
      }
      // Ran under two genuinely different working directories. Compared through `path.normalize`
      // because `process.cwd()` reports the OS-native separator (`\` on Windows) while
      // `sessionWorkspacePaths` builds its strings with `/` — a styling difference, not the
      // distinctness this assertion is actually about.
      expect(resultOne.cwd).not.toBe(resultTwo.cwd);
      expect(path.normalize(resultOne.cwd)).toBe(path.normalize(scopeOne.cwd));
      expect(path.normalize(resultTwo.cwd)).toBe(path.normalize(scopeTwo.cwd));

      // The injected `HOME`/`USERPROFILE` actually determined this no-sandbox process's own
      // `os.homedir()` — proof that `local` passes the caller's environment through unmodified,
      // which is what "no sandbox" means operationally, demonstrated rather than read off the
      // source.
      expect(path.normalize(resultOne.sandboxHomedir)).toBe(path.normalize(hostConfigRoot));
      expect(path.normalize(resultTwo.sandboxHomedir)).toBe(path.normalize(hostConfigRoot));

      // ADR-0046 rule 1, restored: the A.11 environment `buildRuntimeEnvironment` computed for
      // THIS session must actually have reached the process the driver started, proven by
      // reading the directory it named back through that process's own `process.env` — not by
      // reading the test's own local variable. Round 1 had this (`readdirSync(process.env
      // .CLAUDE_CONFIG_DIR)`, which throws when the key is absent or wrong); round 2 dropped it,
      // and a null `buildRuntimeEnvironment` implementation returning `{}` still passed round 2's
      // version of this test (see this round's frozen findings, "defects round 2 introduced").
      // `scope.configDir` was `mkdirSync`'d above, so a correct env makes this a real,
      // non-throwing read. A dropped key is reported as `null`; a readable but mis-wired key is
      // rejected by comparing the value observed inside the child with this session's scope.
      expect(resultOne.envConfigDirEntries).not.toBeNull();
      expect(resultTwo.envConfigDirEntries).not.toBeNull();
      expect(resultOne.envConfigDir).not.toBeNull();
      expect(resultTwo.envConfigDir).not.toBeNull();
      expect(path.normalize(resultOne.envConfigDir ?? '')).toBe(path.normalize(scopeOne.configDir));
      expect(path.normalize(resultTwo.envConfigDir ?? '')).toBe(path.normalize(scopeTwo.configDir));

      // ADR-0047's own scenario: the marker exists only because THIS test wrote it moments ago,
      // so the read is always meaningful, on a machine with a real `~/.claude` and on a CI runner
      // with none — `hostConfigRoot` is fresh every run, on every host, so the verdict below
      // cannot depend on what this particular machine happens to contain (ADR-0039's shape,
      // reappearing in a runtime probe). `local`, which has no sandbox, reaches it.
      expect(resultOne.hostConfigMarker).toBe(hostMarkerToken);
      expect(resultTwo.hostConfigMarker).toBe(hostMarkerToken);

      const hostConfigReachable =
        resultOne.hostConfigMarker === hostMarkerToken &&
        resultTwo.hostConfigMarker === hostMarkerToken;
      const verdict = scenario10Verdict(hostConfigReachable, driver.capabilities.isolation);
      expect(driver.capabilities.isolation).toBe('none');
      // `local` declares `isolation: 'none'` (packages/runtime/src/local.ts) precisely because it
      // cannot enforce this scenario — the honest verdict is therefore never a silent `pass`,
      // regardless of `hostConfigReachable`, and regardless of what this host's own, real
      // `~/.claude` happens to hold (this test never reads it).
      expect(verdict).toBe('unsupported-by-capability');

      // ADR-0046's own question, applied to this gate, for BOTH values of the reachability flag —
      // not only the one this particular run happened to produce: does an implementation that
      // does none of what this check is about (`isolation: 'none'`) still pass? Watched failing,
      // not merely asserted to exist.
      expect(scenario10Verdict(true, 'none')).toBe('unsupported-by-capability');
      expect(scenario10Verdict(false, 'none')).toBe('unsupported-by-capability');
      // ...and a driver that leaked the host's configuration while claiming genuine isolation
      // would FAIL here, never `pass` and never `unsupported-by-capability` —
      for (const realIsolation of ['os-sandbox', 'container', 'gvisor', 'microvm'] as const) {
        expect(scenario10Verdict(true, realIsolation)).toBe('fail');
        // ...while one that actually blocked the read passes, same as `local` would if there
        // were nothing for it to leak.
        expect(scenario10Verdict(false, realIsolation)).toBe('pass');
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(hostConfigRoot, { recursive: true, force: true });
    }
  });
});
