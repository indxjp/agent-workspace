import { describe, expect, it } from 'vitest';
import { PlatformExportResponseSchema } from '@indx-workspace/contracts/platforms';
import { exportAgentVersion } from './export';
import { assertExported, problemOf, world } from './export.test-support';

describe('exportAgentVersion', () => {
  it('compiles one stored version and appends the report file, sorted by path', async () => {
    const { agentId, sources } = await world();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    PlatformExportResponseSchema.parse(outcome.response);
    expect(outcome.agentName).toBe('support-triage');
    expect(outcome.response).toMatchObject({
      agentId,
      version: 1,
      platform: 'claude-managed-agents',
    });
    const paths = outcome.response.files.map((file) => file.path);
    expect(paths).toContain('PLATFORM_REPORT.md');
    expect(paths).toStrictEqual([...paths].sort());
    expect(outcome.response.report.length).toBeGreaterThan(0);
  });

  it.each([
    ['a body that is not an object', 'nope'],
    ['an unknown platform', { version: 1, platform: 'nowhere' }],
    ['a version of zero', { version: 0, platform: 'copilot-studio' }],
    ['an extra key', { version: 1, platform: 'copilot-studio', extra: true }],
  ])('refuses %s with invalid_platform_export', async (_name, body) => {
    const { agentId, sources } = await world();

    const outcome = await exportAgentVersion(agentId, body, sources);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(400);
    expect(problemOf(outcome.result).code).toBe('invalid_platform_export');
  });

  it('answers 404 with [version:9] for a version that was never saved', async () => {
    const { agentId, sources } = await world();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 9, platform: 'copilot-studio' },
      sources,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(404);
    expect(problemOf(outcome.result)).toMatchObject({
      code: 'agent_version_not_found',
      details: ['version:9'],
    });
  });

  it("does not find another workspace's version", async () => {
    const { agentId, otherWorkspace } = await world();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'copilot-studio' },
      otherWorkspace,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(404);
  });

  it('refuses a name a portable agent cannot carry with agent_name_not_portable', async () => {
    const { agentId, sources } = await world({ name: 'Support triage' });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'copilot-studio' },
      sources,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(422);
    expect(problemOf(outcome.result).code).toBe('agent_name_not_portable');
  });

  it('answers a compile refusal with its code and status', async () => {
    const { agentId, sources } = await world({ model: null });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(422);
    expect(problemOf(outcome.result).code).toBe('platform_model_unsupported');
  });

  it('answers a target option error as platform_options_invalid with path: message details', async () => {
    const { agentId, sources } = await world();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'copilot-studio', options: { definitelyNotAnOption: 1 } },
      sources,
    );

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(400);
    const problem = problemOf(outcome.result);
    expect(problem.code).toBe('platform_options_invalid');
    expect(problem.details?.length).toBeGreaterThan(0);
  });
});
