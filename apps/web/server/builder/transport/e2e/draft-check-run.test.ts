/**
 * [US-BLD-02][api][run] A scripted Builder turn calls `draft_check` on a draft naming a connector
 * the workspace lacks: the run's transcript holds the version pipeline's own error, and the journal
 * row carries a server-minted trace id, the model id and prompt version (issue #1846 slice 4).
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { draftBody } from '../../adapters/checker/checker.contract';
import { BUILDER_PROMPT_VERSION } from '../../agent/prompt-version';
import { WORKSPACE, builderDoor, scriptedModel, toolUse } from './harness';

const scopes = () => createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[US-BLD-02][api][run] draft_check in a scripted Builder run', () => {
  it('gets agent_definition_references_missing for connector:erp, journalled with the run', async () => {
    const model = await scriptedModel('builder-draft-check', {
      turns: [
        { toolUses: [toolUse('draft_check', { body: draftBody('Order desk', ['erp']) })] },
        { text: 'The draft names a connector this workspace does not have.' },
      ],
    });
    const door = builderDoor({ featureOn: true, scopes: scopes() });
    const { runId, token } = await door.start({ role: 'builder' }, model);

    const transcript = await door.runScripted(token, model);

    const results = transcript.flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as { type: string; content?: string }[])
        : [],
    );
    const toolResult = results.find((block) => block.type === 'tool_result');
    expect(JSON.parse(toolResult?.content ?? 'null')).toMatchObject({
      ok: false,
      code: 'agent_definition_references_missing',
      details: ['connector:erp'],
    });
    expect(door.journal).toEqual([
      expect.objectContaining({
        runId,
        tool: 'draft_check',
        outcome: 'check_failed',
        code: 'agent_definition_references_missing',
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
        modelId: model,
        promptVersion: BUILDER_PROMPT_VERSION,
      }),
    ]);
  });
});
