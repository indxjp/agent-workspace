import { describe, expect, it } from 'vitest';

import { defineAgent, files, mcp, skill, toAgentVersionBody } from '../define/index.js';
import { defineAgentFromPortable, toPortableAgent } from './index.js';
import {
  openai,
  pi,
  mastra,
  PROJECT,
  MINIMAL,
  ordersApi,
  SAMPLE_PERMISSIONS,
} from './convert.fixture.test-support.js';

describe('round trip', () => {
  const context = { models: PROJECT.models };
  const roundTrip = (agent: ReturnType<typeof defineAgent>) =>
    toAgentVersionBody(
      defineAgentFromPortable(toPortableAgent(agent, { project: PROJECT }).value, context).value,
    );

  it('keeps an agent with mcp, openapi, skills, limits and engine settings', () => {
    const agent = defineAgent({
      name: 'support-triage',
      instructions: 'Triage tickets.',
      model: { connection: 'anthropic', id: 'claude-sonnet-4-6' },
      engine: { id: pi, thinkingLevel: 'low' },
      permissions: SAMPLE_PERMISSIONS,
      tools: [mcp('zendesk'), mcp('events'), ordersApi],
      skills: [skill('refund-policy'), skill('escalation')],
      limits: { maxTurns: 20, maxBudgetUsd: 1.5 },
    });
    expect(roundTrip(agent)).toEqual(toAgentVersionBody(agent));
  });

  it('keeps a compiled Claude agent, and a stored one whose base tool policy is not dropped', () => {
    const compiled = defineAgent({ ...MINIMAL, permissions: SAMPLE_PERMISSIONS });
    expect(roundTrip(compiled)).toEqual(toAgentVersionBody(compiled));

    const stored = defineAgent({
      ...MINIMAL,
      permissions: SAMPLE_PERMISSIONS,
      limits: { maxTurns: 9 },
    });
    const exported = toPortableAgent(stored, { project: PROJECT }).value;
    const back = defineAgentFromPortable(exported, context);
    expect(back.dropped).toEqual([]);
    expect(toAgentVersionBody(back.value)).toEqual(toAgentVersionBody(stored));
  });

  it('keeps a read knowledge file and a read-write one as read-write', () => {
    const grant = (access?: 'read-write') => ({
      ...MINIMAL,
      permissions: { ...SAMPLE_PERMISSIONS, writeFiles: true },
      files: [files('docs/a.md', access)],
      knowledge: [{ kind: 'files' as const, paths: ['docs/a.md'] }],
    });
    const read = defineAgent(grant());
    expect(roundTrip(read)).toEqual(toAgentVersionBody(read));

    const readWrite = defineAgent(grant('read-write'));
    expect(toPortableAgent(readWrite, { project: PROJECT }).dropped).toEqual([]);
    expect(roundTrip(readWrite)).toEqual(toAgentVersionBody(readWrite));
  });

  it('imports a read-write path two knowledge sources name with one read-write grant', () => {
    const agent = defineAgent({
      ...MINIMAL,
      permissions: { ...SAMPLE_PERMISSIONS, writeFiles: true },
      files: [files('docs/a.md', 'read-write'), files('docs/b.md')],
      knowledge: [
        { kind: 'files', paths: ['docs/a.md'] },
        { kind: 'files', paths: ['docs/a.md', 'docs/b.md'] },
      ],
    });
    const portable = toPortableAgent(agent, { project: PROJECT }).value;
    const back = defineAgentFromPortable(portable, context);
    expect(back.dropped).toEqual([]);
    expect(back.value.files).toEqual([files('docs/a.md', 'read-write')]);
  });

  it('imports a read-write knowledge file as read, with a verdict, while writeFiles is off', () => {
    const portable = toPortableAgent(
      defineAgent({
        ...MINIMAL,
        files: [files('docs/a.md', 'read-write')],
        knowledge: [{ kind: 'files', paths: ['docs/a.md'] }],
      }),
      { project: PROJECT },
    ).value;
    const back = defineAgentFromPortable(portable, { models: PROJECT.models });
    expect(back.dropped).toEqual([
      {
        path: 'knowledge.0.access',
        reason: 'grant permissions.writeFiles to keep it read-write',
      },
    ]);
    expect(back.value.files).toBeUndefined();
  });

  it('keeps an agent on each other engine', () => {
    for (const engine of [openai, pi, mastra]) {
      const agent = defineAgent({ ...MINIMAL, engine });
      expect(roundTrip(agent)).toEqual(toAgentVersionBody(agent));
    }
  });
});
