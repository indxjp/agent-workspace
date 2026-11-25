/** Seeds one connector of a template spec into a template workspace's connector store. */
import { admitToolConnector } from '../../connectors/tools';
import type { ConnectorsStoreProvider } from '../../connectors/store';
import type { SeedConnector } from './templates.contract';
import { DEMO_TEMPLATE_CONNECTOR_COMMAND, templateConnectorArgs } from './template-connector';
import type { WorkspaceOwner } from './templates.world.parts.test-support';

type ConnectorStore = ReturnType<ConnectorsStoreProvider['forWorkspace']>;

const OPENAPI_DOCUMENT = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1' },
  servers: [{ url: 'https://93.184.216.34/v1' }],
  paths: {
    '/pets': {
      get: { operationId: 'listPets', responses: {} },
      post: { operationId: 'createPet', responses: {} },
    },
  },
});

type McpConnector = Exclude<SeedConnector, { kind: 'postgres' | 'openapi-read' | 'openapi-write' }>;

/** The body of a connector made through the tool-connector admission path. */
function toolConnectorBody(connector: Exclude<SeedConnector, McpConnector>) {
  if (connector.kind === 'postgres') {
    return {
      kind: 'postgres',
      name: connector.name,
      credential: 'postgres://reader:pw@93.184.216.34:5432/shop',
      tables: ['public.orders'],
      readOnly: true,
    };
  }
  return {
    kind: 'openapi',
    name: connector.name,
    document: OPENAPI_DOCUMENT,
    allow: connector.kind === 'openapi-read' ? ['GET /pets'] : ['GET /pets', 'POST /pets'],
    auth: 'bearer',
    credential: 'token-for-the-template-only',
  };
}

/** Make a `declared` (stdio) or `mcp` (http) connector. */
async function seedServerConnector(
  store: ConnectorStore,
  connector: McpConnector,
  owner: WorkspaceOwner,
): Promise<string> {
  const outcome = await store.create(
    connector.kind === 'declared'
      ? {
          name: connector.name,
          transport: 'stdio',
          command: DEMO_TEMPLATE_CONNECTOR_COMMAND,
          args: templateConnectorArgs(connector.reads, connector.writes, connector.recorded),
          url: null,
          authType: 'none',
          credential: null,
        }
      : {
          name: connector.name,
          transport: 'http',
          command: null,
          args: null,
          url: 'https://mailer.example.test/mcp',
          authType: 'none',
          credential: null,
        },
    owner,
  );
  if (outcome.kind !== 'created') throw new Error(`seeding ${connector.name}: ${outcome.kind}`);
  return outcome.server.id;
}

async function seedToolConnector(
  store: ConnectorStore,
  connector: Exclude<SeedConnector, McpConnector>,
  owner: WorkspaceOwner,
): Promise<string> {
  const admitted = await admitToolConnector(toolConnectorBody(connector), () =>
    Promise.resolve({ ok: true }),
  );
  if (!admitted.ok)
    throw new Error(`seeding ${connector.name}: ${JSON.stringify(admitted.result)}`);
  const made = await store.createToolConnector(admitted.write, owner);
  if (made.kind !== 'created') throw new Error(`seeding ${connector.name}: ${made.kind}`);
  return made.connector.id;
}

export function seedConnector(
  store: ConnectorStore,
  connector: SeedConnector,
  owner: WorkspaceOwner,
): Promise<string> {
  return connector.kind === 'declared' || connector.kind === 'mcp'
    ? seedServerConnector(store, connector, owner)
    : seedToolConnector(store, connector, owner);
}
