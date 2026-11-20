import type { PortableProject } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import {
  ENDPOINT_URL,
  authed,
  compiled,
  rootOf,
  sample,
  text,
  verdictOf,
  withRoot,
  withSubagent,
} from '../../testing/claude-managed-agents-compile.test-support.js';
import { CREDENTIAL_PLAN_FILE, claudeManagedAgentsTarget } from './index.js';

function planOf(project: PortableProject): { mcp_server_url: string; secretRef: string }[] {
  const { files } = compiled(project);
  const plan = JSON.parse(text(files, CREDENTIAL_PLAN_FILE)) as {
    credentials: { mcp_server_url: string; secretRef: string }[];
  };
  return plan.credentials;
}

function refusalMessage(project: PortableProject): string {
  const result = claudeManagedAgentsTarget.compile(project, {});
  if (result.ok) throw new Error('expected a refusal');
  expect(result.refusal.code).toBe('platform_options_invalid');
  return result.refusal.message;
}

describe('claude-managed-agents credential plan refusals', () => {
  it('refuses one URL with two different secrets on one agent', () => {
    const project = withRoot({
      tools: [
        authed('first', 'https://mcp.example.com/shared', 'FIRST_TOKEN'),
        authed('second', 'https://mcp.example.com/shared', 'SECOND_TOKEN'),
      ],
    });
    expect(refusalMessage(project)).toContain('different secrets');
  });

  it('refuses one URL with two different secrets across the root and a subagent', () => {
    const project = withSubagent(
      [authed('second', 'https://mcp.example.com/shared', 'SECOND_TOKEN')],
      withRoot({ tools: [authed('first', 'https://mcp.example.com/shared', 'FIRST_TOKEN')] }),
    );
    expect(refusalMessage(project)).toContain('different secrets');
  });

  it('refuses a user server on the tool endpoint URL with a different secret', () => {
    const code = rootOf(sample).tools.filter((tool) => tool.kind === 'code');
    const project = withRoot({ tools: [authed('mine', ENDPOINT_URL, 'OTHER_TOKEN'), ...code] });
    expect(refusalMessage(project)).toContain('different secrets');
  });

  it('names no URL and no secret in that refusal', () => {
    const message = refusalMessage(
      withRoot({
        tools: [
          authed('first', 'https://mcp.example.com/shared', 'FIRST_TOKEN'),
          authed('second', 'https://mcp.example.com/shared', 'SECOND_TOKEN'),
        ],
      }),
    );
    expect(message).not.toMatch(/mcp\.example\.com|FIRST_TOKEN|SECOND_TOKEN/u);
  });
});

describe('claude-managed-agents credential plan', () => {
  it('plans one credential for one URL used with the same secret by the root and a subagent', () => {
    const shared = authed('shared', 'https://mcp.example.com/shared', 'SHARED_TOKEN');
    const project = withSubagent([shared], withRoot({ tools: [shared] }));
    expect(planOf(project)).toEqual([
      {
        type: 'static_bearer',
        mcp_server_url: 'https://mcp.example.com/shared',
        secretRef: 'SHARED_TOKEN',
      },
    ]);
  });

  it('names static_bearer and the original scheme when api-key or oauth2 is flattened', () => {
    const { report } = compiled(
      withRoot({
        tools: [
          authed('keyed', 'https://mcp.example.com/key', 'KEY_TOKEN', 'api-key'),
          authed('oauth', 'https://mcp.example.com/oauth', 'OAUTH_TOKEN', 'oauth2'),
          authed('plain', 'https://mcp.example.com/plain', 'PLAIN_TOKEN'),
        ],
      }),
    );
    const [keyed, oauth, plain] = [0, 1, 2].map(
      (index) => verdictOf(report, `support-triage.tools.${index}`).note,
    );
    expect(keyed).toContain('static_bearer');
    expect(keyed).toContain('original scheme: api-key');
    expect(oauth).toContain('static_bearer');
    expect(oauth).toContain('original scheme: oauth2');
    expect(plain).toContain('static_bearer');
    expect(plain).not.toContain('original scheme');
  });

  it('names the original scheme of an oauth2 tool endpoint', () => {
    const project: PortableProject = {
      ...sample,
      toolEndpoint: {
        url: ENDPOINT_URL,
        auth: { scheme: 'oauth2', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
      },
    };
    const note = verdictOf(compiled(project).report, 'toolEndpoint').note;
    expect(note).toContain('static_bearer');
    expect(note).toContain('original scheme: oauth2');
  });
});
