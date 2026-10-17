import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compileForPlatform } from './compile.js';
import { dropped, mapped } from './paths.js';
import type { PlatformTarget } from './port.js';
import { SAMPLE_PORTABLE_PROJECT } from './testing/sample.js';
import { fakeTarget } from './testing/fake-target.js';

const sample = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);

describe('compileForPlatform', () => {
  it('refuses a root agent that is not in the project, naming it', () => {
    const result = compileForPlatform(fakeTarget(), { ...sample, root: 'ghost' }, {});
    expect(result).toEqual({
      ok: false,
      refusal: {
        code: 'platform_agent_not_found',
        message: 'The root agent ghost is not in the project.',
        details: ['ghost'],
      },
    });
  });

  it('refuses invalid options with one detail per issue, and never calls the target', () => {
    let called = false;
    const target: PlatformTarget<{ region: string }> = {
      ...fakeTarget(),
      optionsSchema: z.object({ region: z.string() }).strict(),
      compile: () => {
        called = true;
        return { ok: true, files: [], report: [] };
      },
    };
    const result = compileForPlatform(target, sample, { region: 1, extra: true });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('platform_options_invalid');
    expect(result.refusal.details).toHaveLength(2);
    expect(result.refusal.details[0]).toMatch(/^region: /u);
  });

  it('treats undefined options as an empty object', () => {
    expect(compileForPlatform(fakeTarget(), sample, undefined).ok).toBe(true);
  });

  it('clamps the refusal details to 64 entries of 1024 characters', () => {
    const target = fakeTarget({
      optionsSchema: z.object({}).superRefine((_, context) => {
        for (let index = 0; index < 100; index += 1) {
          context.addIssue({ code: 'custom', message: 'x'.repeat(2_000) });
        }
      }),
    });
    const result = compileForPlatform(target, sample, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.details).toHaveLength(64);
    for (const detail of result.refusal.details) expect(detail.length).toBeLessThanOrEqual(1_024);
  });

  it('sorts files by code unit and the report by field order, unknown paths last', () => {
    const target = fakeTarget({
      compile: () => ({
        ok: true,
        files: [
          { path: 'b.txt', content: 'b' },
          { path: 'B.txt', content: 'B' },
          { path: 'a/z.txt', content: 'z' },
        ],
        report: [
          mapped('zeta.extra', 'unknown'),
          mapped('support-triage.instructions', 'second'),
          dropped('alpha.extra', 'field_unsupported', 'unknown'),
          mapped('toolEndpoint', 'first'),
        ],
      }),
    });
    const result = compileForPlatform(target, sample, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.path)).toEqual(['B.txt', 'a/z.txt', 'b.txt']);
    expect(result.report.map((entry) => entry.path)).toEqual([
      'toolEndpoint',
      'support-triage.instructions',
      'alpha.extra',
      'zeta.extra',
    ]);
  });

  it('places the generated description of a root without one in its field slot', () => {
    const bare = { ...sample.agents[0], description: undefined };
    const project = PortableProjectSchema.parse({
      ...sample,
      agents: [bare, ...sample.agents.slice(1)],
    });
    const target = fakeTarget({
      compile: () => ({
        ok: true,
        files: [],
        report: [
          mapped('support-triage.instructions', 'second'),
          mapped('support-triage.description', 'generated'),
          mapped('toolEndpoint', 'first'),
        ],
      }),
    });
    const result = compileForPlatform(target, project, {});
    expect(result.ok && result.report.map((entry) => entry.path)).toEqual([
      'toolEndpoint',
      'support-triage.description',
      'support-triage.instructions',
    ]);
  });

  it('passes a refusal from the target through unchanged', () => {
    const refusal = {
      code: 'platform_model_unsupported',
      message: 'nope',
      details: ['why'],
    } as const;
    const target = fakeTarget({ compile: () => ({ ok: false, refusal }) });
    expect(compileForPlatform(target, sample, {})).toEqual({ ok: false, refusal });
  });
});
