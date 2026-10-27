/**
 * The surface runtime the widget loader's route tests run against (S1-18, issue #456): the real
 * `createSurfaceSessionsRuntime` over the in-memory agent and agent-version stores, with the
 * agent's `local` pointer naming a version that carries surface `main` (C9). Test support only;
 * no route imports it.
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';

import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import { FIXTURE_PERMISSIONS } from '../../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../../agent-versions/memory-store';
import { createSurfaceSessionsRuntime } from '../public/composition';
import { type SurfaceModelRefusal } from '../public/runtime';
import { installTestDomains } from '../../application-context-fixtures';

const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666';
export const WIDGET_WORKSPACE_SLUG = 'widget-loader';
const PRINCIPAL = '36377a6a-7a0b-4610-8efc-d31547dcc38a';

const unreachable = (): never => {
  throw new Error('serving the widget loader or its try page never opens a session');
};

/**
 * Install the surface sessions runtime over in-memory stores, with workspace `WIDGET_WIDGET_WORKSPACE_SLUG`
 * whose agent's `local` pointer names a version carrying surface `main` laid out as `side`. Only
 * the session half that serving a page or loader never reaches is stubbed. The try page's model
 * check (issue #661) answers `modelRefusal`.
 */
export async function installWidgetSurfaceRuntime(
  modelRefusal: SurfaceModelRefusal | null = null,
): Promise<void> {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE_ID).create(
    {
      name: 'Support triage',
      instructions: '',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: PRINCIPAL, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  const versions = createInMemoryAgentVersionStoreProvider({ agents });
  const store = await versions.forWorkspace(WORKSPACE_ID);
  if (store === null) throw new Error('the memory store answers every workspace');
  const saved = await store.create(created.agent.id, {
    summary: 'With a surface',
    via: 'api',
    body: {
      surfaces: [
        {
          name: 'main',
          agent: 'Support triage',
          title: 'Help centre',
          theme: { colour: '#0a7f5a', locale: 'ja' },
          layout: 'side',
        },
      ],
    },
    createdByPrincipalId: PRINCIPAL,
  });
  if (saved.kind !== 'created') throw new Error('the memory store saves the fixture version');
  versions.point({
    workspaceId: WORKSPACE_ID,
    agentId: created.agent.id,
    environment: 'local',
    versionId: saved.version.id,
    number: saved.version.number,
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
  });

  installTestDomains({
    surfaces: {
      kind: 'serving',
      runtime: createSurfaceSessionsRuntime({
        env: () => process.env,
        scopes: createInMemoryWorkspaceScopeResolver([
          { id: WORKSPACE_ID, slug: WIDGET_WORKSPACE_SLUG },
        ]),
        agentVersions: {
          forScope: (scope) => ({
            findById: unreachable,
            findPointedSurface: async (environment, name) => {
              const scoped = await versions.forWorkspace(scope.workspaceId);
              return scoped === null ? null : scoped.findPointedSurface(environment, name);
            },
            list: async (agentId) => {
              const scoped = await versions.forWorkspace(scope.workspaceId);
              return scoped === null ? null : scoped.list(agentId);
            },
            listPointedSurfaceNames: unreachable,
          }),
        },
        agents,
        principalById: (_workspaceId, principalId) =>
          Promise.resolve({
            principalId,
            kind: 'membership',
            role: 'owner',
            label: 'Owner',
            userId: null,
            apiKeyId: null,
            actsForPrincipalId: null,
          }),
        sessions: { forScope: unreachable },
        surfaceSessionKeys: { forScope: unreachable },
        runGate: { isUsable: () => Promise.resolve(true) },
        preflight: () => Promise.resolve(modelRefusal),
        tokens: unreachable,
      }),
    },
  });
}
