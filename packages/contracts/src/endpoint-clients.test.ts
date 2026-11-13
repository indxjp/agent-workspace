import { describe, expect, it } from 'vitest';

import {
  CreateEndpointClientRequestSchema,
  ENDPOINT_CLIENT_AGENTS_MAX,
  ENDPOINT_CLIENT_PROBLEM_CODES,
  EndpointClientListResponseSchema,
  EndpointClientResourceSchema,
  ENDPOINT_CLIENT_REDIRECT_URIS_MAX,
  MintEndpointKeyRequestSchema,
  RedirectUriSchema,
  RotateEndpointClientSecretResponseSchema,
  UpdateEndpointClientRequestSchema,
} from './endpoint-clients.js';
import { TOOL_SANDBOX_TOOLS_MAX } from './agent-versions.js';

const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';

const resource = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'orders',
  kind: 'mcp-project',
  agentIds: [AGENT_A],
  toolNames: null,
  actsForPrincipalId: '44444444-4444-4444-8444-444444444444',
  apiKeyIds: [],
  redirectUris: [],
  oidcAudience: null,
  hasClientSecret: false,
  revokedAt: null,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z',
};

describe('CreateEndpointClientRequestSchema', () => {
  it('accepts an mcp-project client with agents and a tool allow-list', () => {
    const parsed = CreateEndpointClientRequestSchema.safeParse({
      name: 'orders',
      kind: 'mcp-project',
      agentIds: [AGENT_A, AGENT_B],
      toolNames: ['getOrder'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an a2a-agent client with exactly one agent', () => {
    const parsed = CreateEndpointClientRequestSchema.safeParse({
      name: 'support-agent',
      kind: 'a2a-agent',
      agentIds: [AGENT_A],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an a2a-agent client with zero or two agents', () => {
    const base = { name: 'support-agent', kind: 'a2a-agent' };
    expect(CreateEndpointClientRequestSchema.safeParse({ ...base, agentIds: [] }).success).toBe(
      false,
    );
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...base, agentIds: [AGENT_A, AGENT_B] })
        .success,
    ).toBe(false);
  });

  it('takes a builder client with no agent, and refuses one with an agent or toolNames', () => {
    const base = { name: 'builder-door', kind: 'builder' };
    expect(CreateEndpointClientRequestSchema.safeParse({ ...base, agentIds: [] }).success).toBe(
      true,
    );
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...base, agentIds: [AGENT_A] }).success,
    ).toBe(false);
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...base, agentIds: [], toolNames: ['a'] })
        .success,
    ).toBe(false);
  });

  it('still refuses an mcp-project client with no agent', () => {
    expect(
      CreateEndpointClientRequestSchema.safeParse({
        name: 'orders',
        kind: 'mcp-project',
        agentIds: [],
      }).success,
    ).toBe(false);
  });

  it('refuses toolNames on an a2a-agent client, and null is the only empty value allowed', () => {
    const base = { name: 'support-agent', kind: 'a2a-agent', agentIds: [AGENT_A] };
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...base, toolNames: ['getOrder'] }).success,
    ).toBe(false);
    expect(CreateEndpointClientRequestSchema.safeParse({ ...base, toolNames: null }).success).toBe(
      true,
    );
  });

  it('refuses an unknown key, a name that is not kebab-case and 65 agents', () => {
    const valid = { name: 'orders', kind: 'mcp-project', agentIds: [AGENT_A] };
    expect(CreateEndpointClientRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...valid, name: 'Orders_1' }).success,
    ).toBe(false);
    const agentIds = Array.from(
      { length: ENDPOINT_CLIENT_AGENTS_MAX + 1 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(CreateEndpointClientRequestSchema.safeParse({ ...valid, agentIds }).success).toBe(false);
  });

  it('refuses an agent id that is not a UUID', () => {
    expect(
      CreateEndpointClientRequestSchema.safeParse({
        name: 'orders',
        kind: 'mcp-project',
        agentIds: ['not-a-uuid'],
      }).success,
    ).toBe(false);
  });
});

describe('an app-backend client (ADR-0161 D4)', () => {
  const appBackend = {
    name: 'portal',
    kind: 'app-backend',
    agentIds: [AGENT_A],
    oidcAudience: 'portal-web',
  };

  it('takes 1 to 64 agents and an oidcAudience', () => {
    expect(CreateEndpointClientRequestSchema.safeParse(appBackend).success).toBe(true);
    const many = Array.from(
      { length: ENDPOINT_CLIENT_AGENTS_MAX },
      (_, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...appBackend, agentIds: many }).success,
    ).toBe(true);
  });

  it('refuses no agent, 65 agents and toolNames', () => {
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...appBackend, agentIds: [] }).success,
    ).toBe(false);
    const tooMany = Array.from(
      { length: ENDPOINT_CLIENT_AGENTS_MAX + 1 },
      (_, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...appBackend, agentIds: tooMany }).success,
    ).toBe(false);
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...appBackend, toolNames: ['getOrder'] })
        .success,
    ).toBe(false);
  });

  it('requires oidcAudience, bounded to 1 to 255 characters with no surrounding space', () => {
    const withoutAudience = { name: 'portal', kind: 'app-backend', agentIds: [AGENT_A] };
    const missing = CreateEndpointClientRequestSchema.safeParse(withoutAudience);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['oidcAudience']);
    for (const oidcAudience of ['', 'a'.repeat(256), ' portal']) {
      expect(
        CreateEndpointClientRequestSchema.safeParse({ ...appBackend, oidcAudience }).success,
      ).toBe(false);
    }
    expect(
      CreateEndpointClientRequestSchema.safeParse({ ...appBackend, oidcAudience: 'a'.repeat(255) })
        .success,
    ).toBe(true);
  });

  it('refuses oidcAudience on every other kind', () => {
    for (const [kind, agentIds] of [
      ['mcp-project', [AGENT_A]],
      ['a2a-agent', [AGENT_A]],
      ['builder', []],
    ] as const) {
      expect(
        CreateEndpointClientRequestSchema.safeParse({
          name: 'other',
          kind,
          agentIds,
          oidcAudience: 'portal-web',
        }).success,
      ).toBe(false);
    }
  });

  it('renders oidcAudience on the resource, and a patch may change it', () => {
    expect(
      EndpointClientResourceSchema.safeParse({
        ...resource,
        kind: 'app-backend',
        oidcAudience: 'portal-web',
      }).success,
    ).toBe(true);
    expect(
      UpdateEndpointClientRequestSchema.safeParse({ oidcAudience: 'portal-web' }).success,
    ).toBe(true);
    expect(UpdateEndpointClientRequestSchema.safeParse({ oidcAudience: '' }).success).toBe(false);
  });
});

describe('UpdateEndpointClientRequestSchema', () => {
  it('accepts agentIds, toolNames or both, and null clears the allow-list', () => {
    expect(UpdateEndpointClientRequestSchema.safeParse({ agentIds: [AGENT_A] }).success).toBe(true);
    expect(UpdateEndpointClientRequestSchema.safeParse({ toolNames: null }).success).toBe(true);
    expect(
      UpdateEndpointClientRequestSchema.safeParse({ agentIds: [AGENT_A], toolNames: ['a'] })
        .success,
    ).toBe(true);
  });

  it('refuses an empty body, an empty agent list and an unknown key', () => {
    expect(UpdateEndpointClientRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateEndpointClientRequestSchema.safeParse({ agentIds: [] }).success).toBe(false);
    expect(UpdateEndpointClientRequestSchema.safeParse({ kind: 'a2a-agent' }).success).toBe(false);
  });

  it('accepts redirectUris alone, and refuses more than the cap', () => {
    expect(
      UpdateEndpointClientRequestSchema.safeParse({ redirectUris: ['https://a.example/cb'] })
        .success,
    ).toBe(true);
    const redirectUris = Array.from(
      { length: ENDPOINT_CLIENT_REDIRECT_URIS_MAX + 1 },
      (_, index) => `https://a.example/cb${String(index)}`,
    );
    expect(UpdateEndpointClientRequestSchema.safeParse({ redirectUris }).success).toBe(false);
  });
});

describe('RedirectUriSchema', () => {
  it('accepts https and loopback http, and refuses everything else', () => {
    for (const ok of [
      'https://claude.ai/api/mcp/auth_callback',
      'http://localhost:8123/cb',
      'http://127.0.0.1/cb',
      'http://[::1]:3000/cb',
    ]) {
      expect(RedirectUriSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      'http://example.com/cb',
      'javascript:alert(1)',
      'https://a.example/cb#frag',
      'https://user:pw@a.example/cb',
      '/relative',
      '',
    ]) {
      expect(RedirectUriSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('RotateEndpointClientSecretResponseSchema', () => {
  it('carries the secret once, with a warning, and nothing else', () => {
    const body = { clientId: AGENT_A, clientSecret: 'awcs_x', warning: 'shown once' };
    expect(RotateEndpointClientSecretResponseSchema.safeParse(body).success).toBe(true);
    expect(RotateEndpointClientSecretResponseSchema.safeParse({ ...body, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('EndpointClientResourceSchema', () => {
  it('reads a client and refuses a field that could carry a secret', () => {
    expect(EndpointClientResourceSchema.safeParse(resource).success).toBe(true);
    expect(EndpointClientResourceSchema.safeParse({ ...resource, key: 'ak_live_x' }).success).toBe(
      false,
    );
    expect(
      EndpointClientListResponseSchema.safeParse({ endpointClients: [resource] }).success,
    ).toBe(true);
  });
});

describe('MintEndpointKeyRequestSchema', () => {
  it('trims the name and takes an optional expiry', () => {
    const parsed = MintEndpointKeyRequestSchema.parse({
      name: '  copilot-studio  ',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(parsed.name).toBe('copilot-studio');
    expect(MintEndpointKeyRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(MintEndpointKeyRequestSchema.safeParse({ name: 'k', role: 'owner' }).success).toBe(
      false,
    );
  });
});

describe('endpoint-client constants', () => {
  it('keeps the agent cap equal to the tool sandbox cap', () => {
    expect(ENDPOINT_CLIENT_AGENTS_MAX).toBe(TOOL_SANDBOX_TOOLS_MAX);
  });

  it('maps every problem code to its status', () => {
    expect(ENDPOINT_CLIENT_PROBLEM_CODES).toEqual({
      endpoint_client_not_found: 404,
      endpoint_client_name_taken: 409,
      endpoint_client_revoked: 409,
      endpoint_client_agent_not_runnable: 403,
      endpoint_client_invalid: 400,
    });
  });
});
