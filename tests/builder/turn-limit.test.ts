/**
 * Chat 6 of issue #1848 slice 3: a Builder run that hits `BUILDER_RUN_LIMITS.maxTurns` stops with a
 * visible reason. The limit is not enforced at `/api/builder/mcp`, which only sees tool calls: the
 * Claude Agent SDK counts turns. So it is asserted at the two boundaries that carry it, with no
 * model and no SDK process: the shipped definition compiles to the SDK's `maxTurns`, and the SDK's
 * `error_max_turns` result becomes the run's `max_turns` stop reason.
 */
import { createScriptedGateway } from '@agent-workspace/engine/testing';
import { createClaudeAgentSdkEngine } from '@agent-workspace/engine-claude-agent-sdk';
import { classifySdkEvent, toAgentFrames } from '@agent-workspace/run-protocol';
import { BUILDER_RUN_LIMITS } from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import { builderShippedBody } from '../../apps/web/server/builder/agent/definition.js';

describe('[US-BLD-01][api][run] the turn limit stops a Builder run', () => {
  it('compiles the shipped Builder to the SDK maxTurns, and error_max_turns ends the run as max_turns', () => {
    const gateway = createScriptedGateway();
    const compiled = createClaudeAgentSdkEngine().compile({
      runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
      sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
      projectKey: 'tenant-a',
      cwd: '/workspace/builder',
      prompt: 'go',
      engine: 'claude-agent-sdk',
      portable: {
        name: 'builder',
        instructions: '',
        model: null,
        permissions: {
          readFiles: true,
          writeFiles: true,
          runCommands: true,
          unrestrictedNetwork: true,
        },
        skills: { mode: 'allowlist', names: [] },
        mcpServers: {},
        limits: builderShippedBody().definition.policy.limits,
      },
      policy: { tools: null, fileGrantDeny: [] },
      session: { mode: 'fresh' },
      gateway: gateway.connection,
      resources: { files: [], skills: [] },
      env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: gateway.connection.token },
    });
    expect(compiled).toMatchObject({ ok: true });
    expect(compiled.ok && compiled.compiled.maxTurns).toBe(BUILDER_RUN_LIMITS.maxTurns);

    const frames = toAgentFrames(
      classifySdkEvent({
        type: 'result',
        subtype: 'error_max_turns',
        num_turns: BUILDER_RUN_LIMITS.maxTurns,
        total_cost_usd: 0.5,
      }),
    );
    expect(frames).toEqual([
      expect.objectContaining({
        frame: 'agent.result',
        stopReason: 'max_turns',
        turns: BUILDER_RUN_LIMITS.maxTurns,
      }),
    ]);
  });
});
