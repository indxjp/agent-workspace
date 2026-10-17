import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import type { FieldVerdict } from '@indx-workspace/contracts/platforms';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compileForPlatform } from '../compile.js';
import { dropped, mapped } from '../paths.js';
import type { PlatformCompileResult, PlatformTarget } from '../port.js';
import { fakeTarget, type FakeOptions } from './fake-target.js';
import { assertVerdictInvariants, runPlatformConformance } from './invariants.js';
import { SAMPLE_PORTABLE_PROJECT } from './sample.js';

const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);

type Compiled = Extract<PlatformCompileResult, { ok: true }>;

/** The fake with its result rewritten, so each test breaks exactly one invariant. */
function breaking(
  rewrite: (result: Compiled, project: typeof sample) => PlatformCompileResult,
  overrides: Partial<PlatformTarget<FakeOptions>> = {},
): PlatformTarget<FakeOptions> {
  const base = fakeTarget(overrides);
  return {
    ...base,
    compile(project, options) {
      const result = base.compile(project, options);
      return result.ok ? rewrite(result, project) : result;
    },
  };
}

function withReport(change: (report: FieldVerdict[]) => FieldVerdict[]) {
  return (result: Compiled): PlatformCompileResult => ({
    ...result,
    report: change([...result.report]),
  });
}

function expectViolation(target: PlatformTarget, message: RegExp): void {
  expect(() => {
    runPlatformConformance(target);
  }).toThrow(message);
}

describe('runPlatformConformance', () => {
  it('passes the reference target, whatever its platform id', () => {
    for (const id of ['copilot-studio', 'gemini-enterprise', 'eject-mastra'] as const) {
      expect(() => {
        runPlatformConformance(fakeTarget({ id }));
      }).not.toThrow();
    }
  });

  it('compiles with the options it is given, for a target whose options have required keys', () => {
    const base = fakeTarget();
    const needsOptions: PlatformTarget<{ required: true }> = {
      ...base,
      optionsSchema: z.strictObject({ required: z.literal(true) }),
      compile: (project) => base.compile(project, {}),
    };
    expectViolation(needsOptions, /platform_options_invalid/u);
    expect(() => {
      runPlatformConformance(needsOptions, { required: true });
    }).not.toThrow();
  });

  it('names the target in the first line of the failure', () => {
    const target = breaking(withReport((report) => report.slice(1)));
    expect(() => {
      runPlatformConformance(target);
    }).toThrow(/^copilot-studio fails conformance:\n- sample: /u);
  });

  it('fails a field with no verdict, a duplicate and an invented path', () => {
    expectViolation(
      breaking(withReport((report) => report.slice(1))),
      /toolEndpoint has no verdict/u,
    );
    expectViolation(
      breaking(withReport((report) => [...report, ...report.slice(0, 1)])),
      /reported 2 times/u,
    );
    expectViolation(
      breaking(withReport((report) => [...report, mapped('nobody.extra', 'invented')])),
      /nobody\.extra is reported but is not a field/u,
    );
  });

  it('allows a generated description only as mapped', () => {
    const bare = PortableProjectSchema.parse({
      ...sample,
      agents: sample.agents.map((agent) => ({ ...agent, description: undefined })),
    });
    const target = fakeTarget();
    const base = target.compile(bare, {});
    if (!base.ok) throw new Error('the reference target refused');
    const withRow = (row: FieldVerdict): PlatformCompileResult => ({
      ...base,
      report: [...base.report, row],
    });
    expect(() => {
      assertVerdictInvariants(target, bare, withRow(mapped('support-triage.description', 'made')));
    }).not.toThrow();
    expect(() => {
      assertVerdictInvariants(
        target,
        bare,
        withRow(dropped('support-triage.description', 'field_unsupported', 'x')),
      );
    }).toThrow(
      /support-triage\.description is a generated description and must be reported as mapped/u,
    );
    expect(() => {
      assertVerdictInvariants(target, bare, withRow(mapped('nobody.description', 'invented')));
    }).toThrow(/nobody\.description is reported but is not a field/u);
  });

  it('fails a drop without a code and a code on a field that is not dropped', () => {
    expectViolation(
      breaking(
        withReport((report) =>
          report.map((entry) =>
            entry.verdict === 'dropped'
              ? { path: entry.path, verdict: 'dropped', note: '' }
              : entry,
          ),
        ),
      ),
      /is dropped without a code/u,
    );
    expectViolation(
      breaking(
        withReport((report) =>
          report.map((entry) =>
            entry.path === 'toolEndpoint' ? { ...entry, code: 'field_unsupported' } : entry,
          ),
        ),
      ),
      /toolEndpoint is mapped but carries the code field_unsupported/u,
    );
  });

  it('fails a verdict that contradicts the target’s capabilities', () => {
    expectViolation(
      breaking(
        withReport((report) =>
          report.map((entry) =>
            entry.path === 'support-triage.limits.maxTurns'
              ? mapped(entry.path, 'wrongly kept')
              : entry,
          ),
        ),
      ),
      /support-triage\.limits\.maxTurns is mapped but copilot-studio does not support limits/u,
    );
  });

  it('fails a mishandled platform extension', () => {
    const own = breaking(
      withReport((report) =>
        report.map((entry) =>
          entry.path.endsWith('.extensions.platforms.copilot-studio')
            ? dropped(entry.path, 'field_unsupported', 'own options dropped')
            : entry,
        ),
      ),
    );
    expectViolation(
      own,
      /extensions\.platforms\.copilot-studio is the target's own and must be mapped/u,
    );
    const foreign = breaking(
      withReport((report) =>
        report.map((entry) =>
          entry.path.endsWith('.extensions.platforms.eject-mastra')
            ? mapped(entry.path, 'foreign options kept')
            : entry,
        ),
      ),
    );
    expectViolation(foreign, /extensions\.platforms\.eject-mastra belongs to another platform/u);
  });

  it('fails an invalid file, a duplicate path and a credential', () => {
    const emit = (files: Compiled['files']) => (result: Compiled) => ({ ...result, files });
    expectViolation(
      breaking(emit([{ path: '../escape', content: 'x' }])),
      /file \.\.\/escape is invalid/u,
    );
    expectViolation(
      breaking(
        emit([
          { path: 'a.txt', content: 'x' },
          { path: 'a.txt', content: 'y' },
        ]),
      ),
      /file a\.txt is emitted more than once/u,
    );
    expectViolation(
      breaking(emit([{ path: 'a.txt', content: 'key sk-ant-abcdefghijkl' }])),
      /file a\.txt contains a credential/u,
    );
  });

  it('fails an invalid refusal', () => {
    const target = fakeTarget({
      compile: () => ({
        ok: false,
        refusal: { code: 'platform_options_invalid', message: '', details: [] },
      }),
    });
    expectViolation(target, /the refusal is invalid/u);
  });

  it('fails an impure compile, and a compile that tries to mutate its frozen input', () => {
    let calls = 0;
    expectViolation(
      breaking((result) => {
        calls += 1;
        return { ...result, files: [{ path: 'a.txt', content: String(calls) }] };
      }),
      /two compiles of one project differ/u,
    );
    expectViolation(
      breaking((result, project) => {
        (project.agents[0] as { instructions: string }).instructions += '!';
        return result;
      }),
      /sample: compile changed its input project/u,
    );
    expectViolation(
      breaking((result, project) => {
        const nested = project.agents[0]?.extensions?.platforms?.['copilot-studio']?.['nested'];
        if (typeof nested === 'object' && nested !== null) {
          (nested as Record<string, unknown>)['mutated'] = true;
        }
        return result;
      }),
      /sample with extensions: compile changed its input project/u,
    );
  });

  it('fails the D8 drop rules a hosted target must follow', () => {
    const ids = { capabilities: { ...fakeTarget().capabilities, mcpStdio: 'native' } } as const;
    expectViolation(
      breaking(
        withReport((report) =>
          report.map((entry) =>
            entry.path === 'support-triage.tools.1'
              ? dropped(entry.path, 'field_unsupported', 'wrong code')
              : entry,
          ),
        ),
        ids,
      ),
      /support-triage\.tools\.1 must be dropped with stdio_mcp_unsupported/u,
    );
    expectViolation(
      breaking(
        withReport((report) =>
          report.map((entry) =>
            entry.path === 'support-triage.tools.2'
              ? dropped(entry.path, 'field_unsupported', 'wrong code')
              : entry,
          ),
        ),
      ),
      /sample without endpoint: support-triage\.tools\.2 must be dropped with code_tool_needs_public_mcp/u,
    );
    const wrongCode = (path: string) =>
      withReport((report) =>
        report.map((entry) =>
          entry.path === path ? dropped(entry.path, 'limits_unsupported', 'wrong code') : entry,
        ),
      );
    expectViolation(
      breaking(wrongCode('support-triage.engine')),
      /support-triage\.engine must be dropped with field_unsupported/u,
    );
    expectViolation(
      breaking(wrongCode('support-triage.extensions.engines.claude-agent-sdk')),
      /support-triage\.extensions\.engines\.claude-agent-sdk must be dropped with field_unsupported/u,
    );
  });

  it('fails an engine field that an engine-less host drops with the wrong code', () => {
    const wrongCode = withReport((report) =>
      report.map((entry) =>
        /\.engine$|\.extensions\.engines\./u.test(entry.path)
          ? dropped(entry.path, 'limits_unsupported', 'wrong code')
          : entry,
      ),
    );
    const failure = (target: PlatformTarget): string => {
      try {
        runPlatformConformance(target);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return '';
    };

    const engineLines = failure(breaking(wrongCode))
      .split('\n')
      .filter((line) => line.includes('must be dropped with field_unsupported'));
    expect(engineLines).toEqual([
      '- sample with extensions: support-triage.engine must be dropped with field_unsupported (the host runs its own loop)',
      '- sample with extensions: support-triage.extensions.engines.claude-agent-sdk must be dropped with field_unsupported (the host runs its own loop)',
    ]);

    const capabilities = { ...fakeTarget().capabilities, engine: 'native' } as const;
    expect(failure(breaking(wrongCode, { capabilities }))).not.toMatch(/\.engine|engines\./u);
  });

  it('fails an import that does not round-trip', () => {
    const target = fakeTarget({
      import: (files) => {
        const back = fakeTarget().import?.(files);
        if (back === undefined || !back.ok) throw new Error('fake import failed');
        const root = back.project.agents[0];
        return {
          ok: true,
          report: [],
          project: PortableProjectSchema.parse({
            ...back.project,
            agents: [{ ...root, instructions: 'changed' }],
          }),
        };
      },
    });
    expectViolation(target, /import changed the instructions/u);
  });
});

describe('assertVerdictInvariants', () => {
  it('accepts a compile result that follows the model', () => {
    const target = fakeTarget();
    expect(() => {
      assertVerdictInvariants(target, sample, compileForPlatform(target, sample, {}));
    }).not.toThrow();
  });
});
