/** A `builder.allow` name is for an Owner or Admin to give (#1851), through every route that names an agent. */
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PATCH as patchAgent } from '../../app/api/agents/[id]/route';
import { PUT as putPointer } from '../../app/api/agents/[id]/pointers/route';
import { POST as postVersion } from '../../app/api/agents/[id]/versions/route';
import { POST as postAgents } from '../../app/api/agents/route';
import {
  FIXTURE_PERMISSIONS,
  fromVersionRequest,
  versionRequest,
} from '../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../agent-versions/memory-store';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { ROLES, type Role } from '../rbac/roles';
import { recordingCeilingFor } from '../policy-ceiling/fixtures';
import { createInMemoryAgentStoreProvider } from './memory-store';
import type { AgentStoreProvider } from './store';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = 'a0000000-0000-4000-8000-000000000001';
const ROLE_HEADER = 'x-test-role';
const RESERVED = 'hr-onboarding-coordinator';
const CEILING: ProjectPolicy = { builder: { allow: [RESERVED] } };

let agents: AgentStoreProvider;
let ordinaryId: string;

function install(ceiling: boolean): void {
  const deploymentCeiling = ceiling
    ? ({ kind: 'enforced', ceilingFor: recordingCeilingFor(CEILING).ceilingFor } as const)
    : ({ kind: 'disabled' } as const);
  installTestDomains({
    agents: {
      agents,
      agentResources: {
        forWorkspace: () => ({
          get: () =>
            Promise.resolve({ files: [], skillIds: [], connectorIds: [], storageGrants: [] }),
          replace: () => Promise.resolve({ kind: 'not-found' as const }),
        }),
      },
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
      ceiling: deploymentCeiling,
    },
    agentVersions: {
      versions: createInMemoryAgentVersionStoreProvider({ agents }),
      ceiling: deploymentCeiling,
    },
  });
}

beforeEach(async () => {
  agents = createInMemoryAgentStoreProvider();
  const created = await agents
    .forWorkspace(WORKSPACE)
    .create(agentBody('ordinary'), { principalId: PRINCIPAL, userId: null });
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture');
  ordinaryId = created.agent.id;
  install(true);
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: (request) => {
        const role = ROLES.find((candidate) => candidate === request.headers.get(ROLE_HEADER));
        return Promise.resolve(
          role === undefined
            ? null
            : Principal.fromApiKey({
                principalId: PRINCIPAL,
                apiKeyId: 'b0000000-0000-4000-8000-000000000001',
                workspaceId: WORKSPACE,
                role,
                label: `${role} key`,
              }),
        );
      },
    },
  });
});

afterEach(clearApplicationContext);

function send(method: string, path: string, role: Role, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', [ROLE_HEADER]: role },
    body: JSON.stringify(body),
  });
}

const idContext = () => ({ params: Promise.resolve({ id: ordinaryId }) });

const agentBody = (name: string) => ({
  name,
  instructions: '',
  modelConnectionId: null,
  model: null,
  permissions: FIXTURE_PERMISSIONS,
});
const post = (role: Role, body: unknown) => postAgents(send('POST', '/api/agents', role, body));

const CREATES = {
  legacy: (name: string, role: Role) => post(role, agentBody(name)),
  compound: (name: string, role: Role) =>
    post(role, {
      agent: agentBody(name),
      assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
    }),
  version: (name: string, role: Role) => post(role, fromVersionRequest({ name })),
};

const names = async () => (await agents.forWorkspace(WORKSPACE).list()).map((agent) => agent.name);

async function problemCode(response: Response): Promise<unknown> {
  return ((await response.json()) as { error?: { code?: unknown } }).error?.code;
}

describe('creating an agent with a name the deployment allows to build (#1851)', () => {
  it.each(Object.entries(CREATES))(
    'refuses a Member on the %s form and writes nothing',
    async (_form, create) => {
      const response = await create(RESERVED, 'builder');
      expect(response.status).toBe(403);
      expect(await problemCode(response)).toBe('builder_name_reserved');
      expect(await names()).toEqual(['ordinary']);
    },
  );

  it.each(
    Object.entries(CREATES).flatMap(([form, create]) =>
      (['admin', 'owner'] as const).map((role) => [form, role, create] as const),
    ),
  )('on the %s form lets the workspace %s give the name', async (_form, role, create) => {
    expect((await create(RESERVED, role)).status).toBe(201);
    expect(await names()).toContain(RESERVED);
  });

  it.each(Object.entries(CREATES))(
    'does not touch another name on the %s form',
    async (_form, create) => {
      expect((await create('somebody-else', 'builder')).status).toBe(201);
      expect((await create(RESERVED.toUpperCase(), 'builder')).status).toBe(201);
    },
  );

  it('reserves nothing when the deployment has no ceiling', async () => {
    install(false);
    expect((await CREATES.version(RESERVED, 'builder')).status).toBe(201);
  });
});

describe('renaming an agent to a name the deployment allows to build (#1851)', () => {
  it('refuses a Member on PATCH, and an Admin may', async () => {
    const refused = await patchAgent(
      send('PATCH', `/api/agents/${ordinaryId}`, 'builder', { name: RESERVED }),
      idContext(),
    );
    expect(refused.status).toBe(403);
    expect(await problemCode(refused)).toBe('builder_name_reserved');
    expect(await names()).toEqual(['ordinary']);
    const allowed = await patchAgent(
      send('PATCH', `/api/agents/${ordinaryId}`, 'admin', { name: RESERVED }),
      idContext(),
    );
    expect(allowed.status).toBe(200);
    expect(await names()).toEqual([RESERVED]);
  });

  it('lets a Member save an edit that keeps an already-allowed name', async () => {
    const seeded = await agents
      .forWorkspace(WORKSPACE)
      .create(agentBody(RESERVED), { principalId: PRINCIPAL, userId: null });
    if (seeded.kind !== 'created') throw new Error('the memory store creates the fixture');
    const response = await patchAgent(
      send('PATCH', `/api/agents/${seeded.agent.id}`, 'builder', {
        name: RESERVED,
        instructions: 'x',
      }),
      { params: Promise.resolve({ id: seeded.agent.id }) },
    );
    expect(response.status).toBe(200);
    expect((await agents.forWorkspace(WORKSPACE).get(seeded.agent.id))?.instructions).toBe('x');
  });

  it('refuses a Member moving local to a saved version that carries the name', async () => {
    const saved = await postVersion(
      send(
        'POST',
        `/api/agents/${ordinaryId}/versions`,
        'builder',
        versionRequest({ name: RESERVED }),
      ),
      idContext(),
    );
    expect(saved.status).toBe(201);
    const move = (role: Role) =>
      putPointer(
        send('PUT', `/api/agents/${ordinaryId}/pointers`, role, {
          environment: 'local',
          version: 1,
        }),
        idContext(),
      );
    const refused = await move('builder');
    expect(refused.status).toBe(403);
    expect(await problemCode(refused)).toBe('builder_name_reserved');
    expect(await names()).toEqual(['ordinary']);
    expect((await move('admin')).status).toBe(200);
    expect(await names()).toEqual([RESERVED]);
  });
});
