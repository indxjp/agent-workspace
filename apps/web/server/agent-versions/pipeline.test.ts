import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_VERSION_PROBLEM_CODES } from '@indx-workspace/contracts/agent-versions';

import { clearEnginesRegisteredForTests } from '../engines/registry';
import { FIXTURE_POLICY, versionRequest } from './fixtures';
import { expectRefusal, refusalOf, validate } from './pipeline.test-support';

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('validateAgentVersion', () => {
  it('stores a rule written against an MCP connector name by the connector id (ADR-0113 SD13, #1109)', async () => {
    const finder = '00000000-0000-4000-8000-0000000000a1';
    const result = await validate(
      versionRequest({
        policy: {
          ...FIXTURE_POLICY,
          tools: {
            ...FIXTURE_POLICY.tools,
            autoApprove: ['mcp__file-finder__search', 'mcp__pets-tool__list'],
            deny: ['mcp__file-finder__delete', 'mcp__unknown__delete', 'Bash'],
          },
        },
      }),
      {
        references: {
          connector: [
            { id: finder, name: 'file-finder' },
            { id: '00000000-0000-4000-8000-0000000000a2', name: 'pets-tool', tool: true },
          ],
        },
      },
    );
    expect(result.ok && result.policyToStore).toMatchObject({
      tools: {
        // A tool connector keeps its name, and a name no connector has is left as written.
        autoApprove: [`mcp__connector-${finder}__search`, 'mcp__pets-tool__list'],
        deny: [`mcp__connector-${finder}__delete`, 'mcp__unknown__delete', 'Bash'],
      },
    });
  });

  it('accepts a valid body and hands back the normalised request and the stored policy', async () => {
    const result = await validate(versionRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body.definition.agent.name).toBe('Support triage');
    expect(result.policyToStore).toEqual(FIXTURE_POLICY);
    expect(result.references).toEqual({
      modelConnectionId: null,
      runtimeProfileId: null,
      skillIds: [],
      connectorIds: [],
      files: [],
      storageGrants: [],
    });
  });

  describe('1. parse', () => {
    it('answers 400 invalid_agent_version with one dotted path per issue', async () => {
      expectRefusal(
        await validate({ ...versionRequest(), summary: '' }),
        AGENT_VERSION_PROBLEM_CODES.invalid_agent_version,
        'invalid_agent_version',
        [expect.stringMatching(/^summary: /u)],
      );
    });

    it('names the body itself (root) when it is not an object', async () => {
      const refusal = refusalOf(await validate('not a body'));
      expect(refusal.body).toMatchObject({
        error: { code: 'invalid_agent_version', details: [expect.stringMatching(/^\(root\): /u)] },
      });
    });

    it('refuses dryRun: false rather than reading it as a save', async () => {
      const refusal = refusalOf(await validate({ ...versionRequest(), dryRun: false }));
      expect(refusal.body).toMatchObject({ error: { code: 'invalid_agent_version' } });
    });

    it('refuses an agent name that is blank once trimmed (agents_name_not_blank), tabs included', async () => {
      for (const name of [' ', '   ', '\t', ' \u00a0 ']) {
        expectRefusal(
          await validate(versionRequest({ name })),
          AGENT_VERSION_PROBLEM_CODES.invalid_agent_version,
          'invalid_agent_version',
          ['body.definition.agent.name: must not be blank'],
        );
      }
    });

    it('answers unsupported_engine for an unparseable body naming an unregistered engine', async () => {
      const body = versionRequest();
      const raw = {
        ...body,
        body: { ...body.body, definition: { ...body.body.definition, policy: { engine: 'acp' } } },
      };
      expectRefusal(
        await validate(raw),
        AGENT_VERSION_PROBLEM_CODES.unsupported_engine,
        'unsupported_engine',
        ['acp'],
      );
    });
  });

  describe('2. engine', () => {
    it('answers 400 unsupported_engine for a published engine this deployment does not register', async () => {
      expectRefusal(
        await validate(versionRequest(), { registered: ['openai-agents', 'pi', 'mastra'] }),
        400,
        'unsupported_engine',
        ['claude-agent-sdk'],
      );
    });
  });

  describe('3. permission mode', () => {
    it('answers 400 dangerous_permission_mode_refused for bypassPermissions', async () => {
      expectRefusal(
        await validate(
          versionRequest({
            policy: {
              ...FIXTURE_POLICY,
              tools: {
                ...FIXTURE_POLICY.tools,
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
              },
            },
          }),
        ),
        AGENT_VERSION_PROBLEM_CODES.dangerous_permission_mode_refused,
        'dangerous_permission_mode_refused',
      );
    });
  });
});
