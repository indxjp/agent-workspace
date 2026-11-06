import { describe, expect, it } from 'vitest';

import { portableAgentConfigFor } from './run-request';
import { ALL_ON, EMPTY_SHA256, WORKSPACE } from './run-request.fixture.test-support';
export function registerPortableAgentTests() {
  describe('portableAgentConfigFor', () => {
    const agent = {
      id: '55555555-5555-4555-8555-555555555555',
      workspaceId: WORKSPACE,
      name: 'General',
      instructions: 'Be brief.',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: ALL_ON,
      policy: null,
      ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
      createdBy: '66666666-6666-4666-8666-666666666666',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    /** One loaded skill assignment, in the shape `AgentRunResourceLoader` produces. */
    function skillResource(name: string): {
      name: string;
      files: { path: string; size: number; sha256: string }[];
    } {
      return {
        name,
        files: [{ path: 'SKILL.md', size: 0, sha256: EMPTY_SHA256 }],
      };
    }

    it('grants no skill and no connector when no committed assignment was loaded', () => {
      const config = portableAgentConfigFor(agent);
      // `{ mode: 'all' }` would hand a run every skill directory on the image. See the function.
      expect(config.skills).toEqual({ mode: 'allowlist', names: [] });
      expect(config.mcpServers).toEqual({});
      expect(config.limits).toEqual({ maxTurns: null, maxBudgetUsd: null });
      expect(config.name).toBe('General');
      expect(config.instructions).toBe('Be brief.');
      expect(config.model).toBeNull();
    });

    it('appends project instructions without replacing the agent or granting permissions', () => {
      const config = portableAgentConfigFor(
        agent,
        { ...ALL_ON, runCommands: false },
        'Use Q3 sources.',
      );
      expect(config.instructions).toBe('Be brief.\n\nUse Q3 sources.');
      // The permission switch is the portable statement; which tools it removes is the engine's
      // business now (ENG-04b), and `packages/engine-claude-agent-sdk/src/tools.test.ts` asserts it.
      expect(config.permissions.runCommands).toBe(false);
    });

    it('carries no tool vocabulary at all, so a second engine cannot be handed Claude tool names', () => {
      expect('tools' in portableAgentConfigFor(agent)).toBe(false);
    });

    it('turns off the switches an openai-agents arm withholds, over an override too (ADR-0074 D12)', () => {
      const withholding = {
        ...agent,
        policy: {
          engine: 'openai-agents' as const,
          withheldPermissions: ['writeFiles', 'runCommands'] as const,
          skills: { mode: 'all' as const },
          limits: { maxTurns: null, maxBudgetUsd: null },
        },
      };
      expect(portableAgentConfigFor(withholding).permissions).toEqual({
        ...ALL_ON,
        writeFiles: false,
        runCommands: false,
      });
      expect(
        portableAgentConfigFor(withholding, { ...ALL_ON, readFiles: false }).permissions,
      ).toEqual({
        readFiles: false,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: true,
      });
    });

    // ── S-13: a stored policy is strictly narrowing ──────────────────────────────────────────
    describe('a stored policy (S-13)', () => {
      const narrowedAgent = {
        ...agent,
        permissions: { ...ALL_ON, runCommands: false },
        policy: {
          engine: 'claude-agent-sdk' as const,
          tools: {
            base: 'claude_code_preset' as const,
            // Tries to re-enable Bash, which `permissions.runCommands: false` denies.
            autoApprove: ['Bash'],
            deny: [],
            permissionMode: 'default' as const,
            allowDangerouslySkipPermissions: false,
          },
          skills: { mode: 'allowlist' as const, names: ['triage'] },
          limits: { maxTurns: 12, maxBudgetUsd: 4.5 },
        },
      };

      it('carries the stored limits through to the compiled config', () => {
        const config = portableAgentConfigFor(narrowedAgent);
        expect(config.limits).toEqual({ maxTurns: 12, maxBudgetUsd: 4.5 });
      });

      it('carries the stored skills allowlist through for a name that is still assigned', () => {
        const config = portableAgentConfigFor(narrowedAgent, undefined, null, {
          files: [],
          skills: [skillResource('triage')],
          mcpServers: {},
        });
        expect(config.skills).toEqual({ mode: 'allowlist', names: ['triage'] });
      });

      // Review finding (AC2): `skills` is the only lever bounding a run's skill surface, so the
      // assignments are its ceiling at compose time exactly as the permission booleans are for
      // `deny`. A stored policy that outlives an assignment must not re-grant it.
      it('compiles a stored mode: all against zero assignments as an empty allowlist, never all', () => {
        const config = portableAgentConfigFor({
          ...narrowedAgent,
          policy: { ...narrowedAgent.policy, skills: { mode: 'all' as const } },
        });
        expect(config.skills).toEqual({ mode: 'allowlist', names: [] });
      });

      it('compiles a stored mode: all as exactly the skills currently assigned', () => {
        const config = portableAgentConfigFor(
          {
            ...narrowedAgent,
            policy: { ...narrowedAgent.policy, skills: { mode: 'all' as const } },
          },
          undefined,
          null,
          { files: [], skills: [skillResource('triage')], mcpServers: {} },
        );
        expect(config.skills).toEqual({ mode: 'allowlist', names: ['triage'] });
      });

      it('drops an allowlisted skill whose assignment has since been revoked', () => {
        const config = portableAgentConfigFor(
          {
            ...narrowedAgent,
            policy: {
              ...narrowedAgent.policy,
              skills: { mode: 'allowlist' as const, names: ['triage', 'revoked'] },
            },
          },
          undefined,
          null,
          { files: [], skills: [skillResource('triage')], mcpServers: {} },
        );
        expect(config.skills).toEqual({ mode: 'allowlist', names: ['triage'] });
      });

      it('carries the assigned connectors through by record key, not as tool approvals', () => {
        const config = portableAgentConfigFor(narrowedAgent, undefined, null, {
          files: [],
          skills: [],
          mcpServers: { github: { type: 'http', url: 'https://mcp.example' } },
        });
        expect(Object.keys(config.mcpServers)).toEqual(['github']);
      });
    });
  });
}
