import { describe, expect, it } from 'vitest';
import { PLATFORM_EXPORT_MAX_BYTES } from '@indx-workspace/contracts/platforms';
import { exportAgentVersion, exportFileBytes } from './export';
import { assertExported, encode, problemOf, world } from './export.test-support';

describe('exportAgentVersion skill files', () => {
  it('round-trips a non-UTF-8 skill file as base64 and keeps text as utf8', async () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const { agentId, sources } = await world({
      skills: ['triage-guide'],
      skillFiles: {
        'triage-guide': [
          {
            path: 'SKILL.md',
            bytes: encode('---\nname: triage-guide\ndescription: Triage.\n---\nBody\n'),
          },
          { path: 'assets/blob.bin', bytes: binary },
        ],
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    const blob = outcome.response.files.find((file) => file.path.endsWith('blob.bin'));
    expect(blob?.encoding).toBe('base64');
    if (blob === undefined) throw new Error('the skill asset is exported');
    expect(new Uint8Array(exportFileBytes(blob))).toStrictEqual(binary);
    const skill = outcome.response.files.find((file) => file.path.endsWith('SKILL.md'));
    expect(skill?.encoding).toBe('utf8');
  });

  it('refuses an export over PLATFORM_EXPORT_MAX_BYTES with 422 platform_export_too_large', async () => {
    const { agentId, sources } = await world({
      skills: ['triage-guide'],
      skillFiles: {
        'triage-guide': [
          {
            path: 'SKILL.md',
            bytes: encode('---\nname: triage-guide\ndescription: Triage.\n---\nBody\n'),
          },
          { path: 'assets/huge.bin', bytes: new Uint8Array(PLATFORM_EXPORT_MAX_BYTES + 1) },
        ],
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    if (outcome.ok) throw new Error('the over-size export is refused');
    expect(outcome.result.status).toBe(422);
    const error = problemOf(outcome.result);
    expect(error.code).toBe('platform_export_too_large');
    expect(error.details?.[0]).toMatch(/^bytes:\d+$/u);
    expect(error.details?.[1]).toBe('max:8388608');
  });

  it('reports a skill that has no SKILL.md as dropped instead of failing', async () => {
    const { agentId, sources } = await world({ skills: ['gone'], skillFiles: {} });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    expect(outcome.response.report).toContainEqual(
      expect.objectContaining({
        path: 'agents.support-triage.skills.0',
        verdict: 'dropped',
        code: 'field_unsupported',
      }),
    );
  });

  it('does not count a dropped skill toward the size cap, and never reads it', async () => {
    const { agentId, sources, reads } = await world({
      skills: ['broken', 'triage-guide'],
      skillFiles: {
        broken: [{ path: 'assets/huge.bin', bytes: new Uint8Array(PLATFORM_EXPORT_MAX_BYTES + 1) }],
        'triage-guide': [
          {
            path: 'SKILL.md',
            bytes: encode('---\nname: triage-guide\ndescription: Triage.\n---\nBody\n'),
          },
        ],
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    expect(outcome.response.report).toContainEqual(
      expect.objectContaining({
        path: 'agents.support-triage.skills.0',
        verdict: 'dropped',
      }),
    );
    expect(reads).toStrictEqual(['triage-guide/SKILL.md']);
  });
});
