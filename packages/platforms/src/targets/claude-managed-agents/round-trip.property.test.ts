/**
 * Property test for the Claude Managed Agents translator (F-21 property 7): importing what the
 * compiler wrote gives back every agent field the compile report calls `native` — carried
 * verbatim — for arbitrary agent text and permissions, and no emitted file matches a credential
 * pattern. A `mapped` field is translated, not preserved (`code_execution` imports back as
 * `runCommands`), so only `native` ones are compared. The project varies the shared sample, so every tool, skill and subagent shape the
 * sample holds is in each case. On a failure fast-check prints the seed and path.
 */
import {
  PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH,
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import {
  assertVerdictInvariants,
  CREDENTIAL_PATTERNS,
  SAMPLE_PORTABLE_PROJECT,
} from '../../testing/index.js';
import { claudeManagedAgentsTarget, importClaudeManagedAgents } from './index.js';

const clean = (value: string): boolean =>
  !CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));

/** Text a translator has to escape: front-matter fences, YAML indicators, quotes, newlines. */
const prose = fc
  .array(
    fc.oneof(
      fc.constantFrom('---', '\n', '\n---\n', ': ', '# ', '- ', '"', "'", '|', '>', '{', '\\'),
      fc.constantFrom('é', '😀', '\t', ' ', 'name: x', '\r\n'),
      fc.string({ maxLength: 8 }),
    ),
    { maxLength: 20 },
  )
  .map((parts) => parts.join(''))
  .filter(clean);

const description = prose.filter(
  (value) => value.trim() !== '' && value.length <= PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH,
);

/**
 * Instructions that end in a line break, or are only whitespace, do not survive the round trip:
 * the compiler writes `X` and `X\n` as the same Markdown body and the importer drops a blank one.
 * Pinned by the RF-001 characterization below and excluded here by name.
 */
function losesBodyWhitespace(instructions: string): boolean {
  return /\r?\n$/u.test(instructions) || (instructions !== '' && instructions.trim() === '');
}

const agentText = fc.record({
  description,
  instructions: prose.filter((value) => !losesBodyWhitespace(value)),
  permissions: fc.record({
    readFiles: fc.boolean(),
    writeFiles: fc.boolean(),
    runCommands: fc.boolean(),
    unrestrictedNetwork: fc.boolean(),
  }),
});

const project = fc
  .array(agentText, {
    minLength: SAMPLE_PORTABLE_PROJECT.agents.length,
    maxLength: SAMPLE_PORTABLE_PROJECT.agents.length,
  })
  .map((texts) =>
    PortableProjectSchema.safeParse({
      ...SAMPLE_PORTABLE_PROJECT,
      agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent, index) => ({ ...agent, ...texts[index] })),
    }),
  )
  .filter((parsed) => parsed.success)
  .map((parsed) => parsed.data);

/** The agent field a report path names, when it is one this test varies. */
function carried(projectValue: PortableProject, path: string): { found: boolean; value?: unknown } {
  for (const agent of projectValue.agents) {
    if (!path.startsWith(`${agent.name}.`)) continue;
    const field = path.slice(agent.name.length + 1);
    if (field === 'description') return { found: true, value: agent.description };
    if (field === 'instructions') return { found: true, value: agent.instructions };
    const permission = /^permissions\.(\w+)$/u.exec(field)?.[1];
    if (permission !== undefined) {
      return {
        found: true,
        value: (agent.permissions as Readonly<Record<string, unknown>>)[permission],
      };
    }
  }
  return { found: false };
}

describe('claude-managed-agents compile ∘ import (property)', () => {
  it('preserves every carried agent field and emits no credential', () => {
    fc.assert(
      fc.property(project, (input) => {
        const compiled = compileForPlatform(claudeManagedAgentsTarget, input, {});
        assertVerdictInvariants(claudeManagedAgentsTarget, input, compiled);
        if (!compiled.ok) throw new Error(`refused: ${compiled.refusal.message}`);
        const imported = importClaudeManagedAgents(compiled.files);
        if (!imported.ok) throw new Error(`import refused: ${imported.refusal.message}`);
        let checked = 0;
        for (const entry of compiled.report) {
          if (entry.verdict !== 'native') continue;
          const before = carried(input, entry.path);
          if (!before.found) continue;
          checked += 1;
          expect(carried(imported.project, entry.path), entry.path).toEqual(before);
        }
        expect(checked).toBeGreaterThan(0);
      }),
      { numRuns: 150 },
    );
  });
});

describe('claude-managed-agents instructions whitespace (characterization)', () => {
  it.fails('RF-001: round-trips instructions that end in a line break', () => {
    const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    const input = PortableProjectSchema.parse({
      ...sample,
      agents: sample.agents.map((agent) => ({ ...agent, instructions: 'Answer briefly.\n' })),
    });
    const compiled = compileForPlatform(claudeManagedAgentsTarget, input, {});
    if (!compiled.ok) throw new Error(compiled.refusal.message);
    const imported = importClaudeManagedAgents(compiled.files);
    if (!imported.ok) throw new Error(imported.refusal.message);
    expect(imported.project.agents[0]?.instructions).toBe('Answer briefly.\n');
  });
});

describe('claude-managed-agents description with whitespace-only lines (#1598)', () => {
  it('round-trips a multi-line description the YAML writer would fold', () => {
    // fast-check seed 464946133. `yaml` folds a long multi-line double-quoted scalar and writes a
    // line holding only a space as an escaped backslash, so it read back as a backslash.
    const description = ['', '---', ' ', '\r', '---\\' + ' '.repeat(8) + '\\' + ' '.repeat(9)].join(
      '\n',
    );
    const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    const input = PortableProjectSchema.parse({
      ...sample,
      agents: sample.agents.map((agent) => ({ ...agent, description })),
    });
    const compiled = compileForPlatform(claudeManagedAgentsTarget, input, {});
    if (!compiled.ok) throw new Error(compiled.refusal.message);
    const imported = importClaudeManagedAgents(compiled.files);
    if (!imported.ok) throw new Error(imported.refusal.message);
    expect(imported.project.agents.map((agent) => agent.description)).toEqual(
      input.agents.map(() => description),
    );
  });
});
