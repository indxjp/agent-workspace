import {
  credentialFieldFor,
  credentialHeaderValue,
  identityOf,
  toToolConnectorResource,
  type ConnectorResource,
} from './contract';
import type {
  RepositoryConnectorsStoreDependencies,
  ConnectorFieldPatch,
  UpdateConnectorOutcome,
  UpdateToolConnectorOutcome,
  ResolvedConnectorProbeConfig,
} from './store';

type ConnectorRepository = ReturnType<
  RepositoryConnectorsStoreDependencies['mcpServers']['forScope']
>;
type CoreMcpServerRecord = NonNullable<Awaited<ReturnType<ConnectorRepository['get']>>>;
type CoreUpdateMcpServerOutcome = Awaited<ReturnType<ConnectorRepository['update']>>;
type CoreUpdateMcpServerInput = Parameters<ConnectorRepository['update']>[1];
type CoreUpdateToolConnectorOutcome = Awaited<
  ReturnType<ConnectorRepository['updateToolConnector']>
>;

function toResource(record: CoreMcpServerRecord): ConnectorResource {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    transport: record.transport,
    command: record.command,
    args: record.args,
    url: record.url,
    authType: record.authType,
    hasCredential: record.credentialSecretId !== null,
    enabled: record.enabled,
    createdBy: record.createdBy,
    ownerPrincipalId: record.ownerPrincipalId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...identityOf(record.identitySecretName),
  };
}

function toUpdateOutcome(result: CoreUpdateMcpServerOutcome): UpdateConnectorOutcome {
  switch (result.kind) {
    case 'updated':
      return { kind: 'updated', connector: toResource(result.server) };
    case 'name-conflict':
      return { kind: 'name-conflict', name: result.name };
    case 'not-found':
      return { kind: 'not-found' };
    case 'unknown-credential-secret':
      // The secret was sealed in this same request; a foreign-key miss here is a defect.
      throw new Error(`connector update named a credential secret that does not exist`);
    default: {
      const unreachable: never = result;
      throw new Error(`unhandled connector update outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

function fieldsOf(patch: ConnectorFieldPatch): CoreUpdateMcpServerInput {
  return {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.command === undefined ? {} : { command: patch.command }),
    ...(patch.args === undefined ? {} : { args: patch.args === null ? null : [...patch.args] }),
    ...(patch.url === undefined ? {} : { url: patch.url }),
    ...(patch.authType === undefined ? {} : { authType: patch.authType }),
    ...(patch.identity === undefined
      ? {}
      : { identitySecretName: patch.identity === null ? null : patch.identity.secret }),
  };
}

function buildTestConfig(
  record: CoreMcpServerRecord,
  credentialValue: string | null,
): ResolvedConnectorProbeConfig {
  const field = credentialFieldFor(record.transport, record.authType);
  const credentialConfigured = field !== null && credentialValue !== null;

  if (record.transport === 'stdio') {
    const env: Record<string, string> = {};
    if (field?.kind === 'env' && credentialValue !== null) env[field.name] = credentialValue;
    return {
      transport: 'stdio',
      command: record.command ?? '',
      args: record.args ?? [],
      env,
      credentialConfigured,
    };
  }
  const headers: Record<string, string> = {};
  if (field?.kind === 'header' && credentialValue !== null) {
    headers[field.name] = credentialHeaderValue(record.authType, credentialValue);
  }
  return {
    transport: record.transport,
    url: record.url ?? '',
    headers,
    credentialConfigured,
  };
}

function toToolUpdateOutcome(result: CoreUpdateToolConnectorOutcome): UpdateToolConnectorOutcome {
  switch (result.kind) {
    case 'updated':
      return { kind: 'updated', connector: toToolConnectorResource(result.connector) };
    case 'name-conflict':
      return { kind: 'name-conflict', name: result.name };
    case 'not-found':
      return { kind: 'not-found' };
    case 'unknown-credential-secret':
      // The secret was sealed in this same request; a foreign-key miss here is a defect.
      throw new Error('tool connector update named a credential secret that does not exist');
    default: {
      const unreachable: never = result;
      throw new Error(`unhandled tool connector update outcome ${JSON.stringify(unreachable)}`);
    }
  }
}
export { toResource, toUpdateOutcome, fieldsOf, buildTestConfig, toToolUpdateOutcome };

export function byCreatedThenId(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
