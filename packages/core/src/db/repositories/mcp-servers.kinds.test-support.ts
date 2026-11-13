import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { mcpServers, type NewMcpServer } from '../schema/mcp-servers.js';
import {
  created,
  httpConnector,
  openapiConfig,
  postgresConfig,
  type McpServerFixture,
} from './mcp-servers.fixture.test-support.js';
import { registerToolConnectorCases } from './mcp-servers.tool-connectors.test-support.js';
import { postgresViolations, type PostgresViolation } from './violations.js';

const stdio: Partial<NewMcpServer> = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server'],
};
const http: Partial<NewMcpServer> = { transport: 'http', url: 'https://mcp.example.test/mcp' };
const sse: Partial<NewMcpServer> = { transport: 'sse', url: 'https://mcp.example.test/sse' };

async function violationsOf(write: Promise<unknown>): Promise<readonly PostgresViolation[]> {
  try {
    await write;
  } catch (error) {
    return [...postgresViolations(error)];
  }
  throw new Error('the write was expected to be refused');
}

function kindsHelpers(fixture: McpServerFixture) {
  let rowCounter = 0;
  /** A raw row in workspace A, bypassing the repository, with a fresh name. */
  const rawRow = (overrides: Partial<NewMcpServer>): NewMcpServer => {
    rowCounter += 1;
    return {
      workspaceId: fixture.workspaceA.id,
      name: `kind-matrix-${String(rowCounter)}`,
      ownerPrincipalId: fixture.principalA,
      ...overrides,
    };
  };
  const insertRaw = (overrides: Partial<NewMcpServer>): Promise<unknown> =>
    fixture.isolated.db.insert(mcpServers).values(rawRow(overrides));
  const refusedBy = async (overrides: Partial<NewMcpServer>, constraint: string): Promise<void> => {
    expect(await violationsOf(insertRaw(overrides))).toContainEqual({ code: '23514', constraint });
  };
  return { fixture, rawRow, insertRaw, refusedBy };
}

type Kinds = ReturnType<typeof kindsHelpers>;

function registerRowShapeCases({ fixture, rawRow, refusedBy }: Kinds): void {
  it('accepts MCP stdio, http and sse rows as kind mcp with no tool_config', async () => {
    for (const shape of [stdio, http, sse]) {
      const rows = await fixture.isolated.db
        .insert(mcpServers)
        .values(rawRow(shape))
        .returning({ kind: mcpServers.kind, toolConfig: mcpServers.toolConfig });
      expect(rows).toEqual([{ kind: 'mcp', toolConfig: null }]);
    }
  });

  it('refuses an MCP row with no transport', async () => {
    await refusedBy(
      { kind: 'mcp', transport: null, url: 'https://x.example.test' },
      'mcp_servers_transport_by_kind',
    );
  });

  it('refuses a tool row that carries any MCP-only field', async () => {
    for (const kind of ['openapi', 'postgres'] as const) {
      const base = {
        kind,
        toolConfig: kind === 'openapi' ? openapiConfig : postgresConfig,
        credentialSecretId: fixture.secretInA,
      };
      await refusedBy({ ...base, transport: 'http' }, 'mcp_servers_transport_by_kind');
      await refusedBy({ ...base, command: 'npx' }, 'mcp_servers_tool_kind_fields');
      await refusedBy({ ...base, url: 'https://x.example.test' }, 'mcp_servers_tool_kind_fields');
      await refusedBy({ ...base, args: ['-y'] }, 'mcp_servers_tool_kind_fields');
    }
  });

  it('pairs tool_config with the kind and requires a JSON object', async () => {
    await refusedBy({ kind: 'openapi' }, 'mcp_servers_tool_config_by_kind');
    await refusedBy({ ...stdio, toolConfig: openapiConfig }, 'mcp_servers_tool_config_by_kind');
    // `$type` is a compile-time hint, so the non-object values are written as raw SQL.
    for (const [index, json] of ['[1, 2]', '"text"'].entries()) {
      const write = fixture.isolated.db.execute(sql`
        insert into mcp_servers (workspace_id, name, kind, tool_config, owner_principal_id)
        values (${fixture.workspaceA.id}, ${`kind-matrix-json-${String(index)}`}, 'openapi',
                ${json}::jsonb, ${fixture.principalA})
      `);
      expect(await violationsOf(write)).toContainEqual({
        code: '23514',
        constraint: 'mcp_servers_tool_config_is_object',
      });
    }
  });
}

function registerRowCredentialCases({ fixture, insertRaw, refusedBy }: Kinds): void {
  it('pins a tool row to auth_type none and a postgres row to a credential', async () => {
    const { secretInA } = fixture;
    await refusedBy(
      {
        kind: 'openapi',
        toolConfig: openapiConfig,
        authType: 'bearer',
        credentialSecretId: secretInA,
      },
      'mcp_servers_tool_credential',
    );
    await refusedBy(
      { kind: 'postgres', toolConfig: postgresConfig },
      'mcp_servers_tool_credential',
    );
    await expect(insertRaw({ kind: 'openapi', toolConfig: openapiConfig })).resolves.toBeDefined();
    await expect(
      insertRaw({ kind: 'postgres', toolConfig: postgresConfig, credentialSecretId: secretInA }),
    ).resolves.toBeDefined();
  });

  it('keeps the MCP transport and credential checks for MCP rows', async () => {
    await refusedBy({ ...stdio, authType: 'bearer' }, 'mcp_servers_credential_required');
    await refusedBy({ transport: 'stdio' }, 'mcp_servers_stdio_has_command');
    await refusedBy({ transport: 'http' }, 'mcp_servers_remote_has_url');
    await refusedBy({ ...http, args: ['-y'] }, 'mcp_servers_args_are_stdio_only');
  });

  it('stores an identity secret name only on http/sse MCP and openapi rows (ADR-0142 D1)', async () => {
    const identity = { identitySecretName: 'IDENTITY_KEY' };
    await refusedBy({ ...stdio, ...identity }, 'mcp_servers_identity_transport');
    await refusedBy(
      {
        kind: 'postgres',
        toolConfig: postgresConfig,
        credentialSecretId: fixture.secretInA,
        ...identity,
      },
      'mcp_servers_identity_transport',
    );
    await refusedBy({ ...http, identitySecretName: '  ' }, 'mcp_servers_identity_transport');
    for (const row of [
      { ...http, ...identity },
      { ...sse, ...identity },
      { kind: 'openapi' as const, toolConfig: openapiConfig, ...identity },
    ]) {
      await expect(insertRaw(row)).resolves.toBeDefined();
    }
  });
}

function registerIdentityAndUnknownKindCases({ fixture }: Kinds): void {
  it('round-trips the identity secret name through the repository, and clears it with null', async () => {
    const ws = await fixture.freshWorkspace();
    const repo = fixture.repo(ws.scope);
    const { server } = created(
      await repo.create(
        httpConnector({
          name: 'Signed MCP',
          identitySecretName: 'IDENTITY_KEY',
          ownerPrincipalId: ws.principalId,
        }),
      ),
    );
    expect(server.identitySecretName).toBe('IDENTITY_KEY');
    expect((await repo.get(server.id))?.identitySecretName).toBe('IDENTITY_KEY');

    const cleared = await repo.update(server.id, { identitySecretName: null });
    expect(cleared).toMatchObject({ kind: 'updated', server: { identitySecretName: null } });
  });

  it('refuses an unknown kind', async () => {
    const write = fixture.isolated.db.execute(sql`
      insert into mcp_servers (workspace_id, name, kind, tool_config, owner_principal_id)
      values (${fixture.workspaceA.id}, 'kind-matrix-grpc', 'grpc', '{}'::jsonb, ${fixture.principalA})
    `);
    expect(await violationsOf(write)).toContainEqual({
      code: '23514',
      constraint: 'mcp_servers_kind_valid',
    });
  });
}

/** The connector kind matrix: MCP rows beside openapi and postgres tool connectors. */
export function registerConnectorKindsCases(fixture: McpServerFixture): void {
  describe('connector kinds (issue #527, ADR-0113 C15)', () => {
    const kinds = kindsHelpers(fixture);
    registerRowShapeCases(kinds);
    registerRowCredentialCases(kinds);
    registerIdentityAndUnknownKindCases(kinds);
    registerToolConnectorCases(fixture);
  });
}
