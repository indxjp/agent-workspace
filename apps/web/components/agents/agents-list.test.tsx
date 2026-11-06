// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentResource } from '../../contracts/agents';
import { AgentsListScreen } from './agents-list';

const listed = vi.hoisted(() => ({ agents: [] as AgentResource[] }));

vi.mock('./agent-requests-model', () => ({
  loadAgents: () => Promise.resolve({ ok: true, value: listed.agents }),
}));
vi.mock('../../lib/browser-client', () => ({ browserClient: () => ({}) }));
vi.mock('../shares/share-dialog', () => ({ ShareDialog: () => null }));

function agent(id: string, name: string, builtin?: 'builder'): AgentResource {
  return {
    id,
    workspaceId: 'w1',
    name,
    instructions: `${name} instructions`,
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    createdBy: null,
    ownerPrincipalId: 'p1',
    ...(builtin === undefined ? {} : { builtin }),
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

let container: HTMLDivElement | null = null;

afterEach(() => {
  container?.remove();
  container = null;
});

async function renderList(agents: AgentResource[]): Promise<string> {
  listed.agents = agents;
  const element = document.createElement('div');
  container = element;
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(<AgentsListScreen locale="en" />);
    await Promise.resolve();
  });
  const text = element.textContent;
  act(() => {
    root.unmount();
  });
  return text;
}

describe('AgentsListScreen and the built-in Builder (UX-26)', () => {
  it('lists the workspace agents and leaves the Builder out, count included', async () => {
    const text = await renderList([
      agent('a1', 'Research'),
      agent('b1', 'builder', 'builder'),
      agent('a2', 'Support'),
    ]);
    expect(text).toContain('Research');
    expect(text).toContain('Support');
    expect(text).toContain('2 agents');
    expect(text).not.toContain('builder instructions');
  });

  it('says the workspace has no agents yet when the Builder is the only one', async () => {
    const text = await renderList([agent('b1', 'builder', 'builder')]);
    expect(text).toContain('This workspace has no agents yet.');
    expect(text).toContain('0 agents');
    expect(text).not.toContain('builder instructions');
  });
});
