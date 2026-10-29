// @vitest-environment happy-dom
import { createClient } from '@indx-workspace/sdk';
import { fetchDouble, fixtures, jsonResponse, type FetchDouble } from '@indx-workspace/sdk/testing';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRestoreCapability } from '../../contracts/agents';
import { AgentArchivedNotice, ArchivedBadge, ArchivedNotice } from './agent-archived';
import { AgentsListScreen } from './agents-list';

const double: { current: FetchDouble } = {
  current: fetchDouble(() => jsonResponse(500, { error: { code: 'unset', message: 'unset' } })),
};
vi.mock('../../lib/browser-client', () => ({
  // Read at call time, so each test can install its own double after the module graph is built.
  browserClient: () =>
    createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: (input, init) => double.current.fetch(input, init),
    }),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = 'principal-viewer';
const ARCHIVED_AT = '2026-10-01T09:30:00.000Z';
const NO_ONE: AgentRestoreCapability = {
  canRestoreOwn: false,
  canRestoreOther: false,
  viewerPrincipalId: null,
};
const OWNER_VIEWER: AgentRestoreCapability = {
  canRestoreOwn: true,
  canRestoreOther: true,
  viewerPrincipalId: VIEWER,
};

const archived = (overrides: Partial<ReturnType<typeof fixtures.agent>> = {}) =>
  fixtures.agent({ archivedAt: ARCHIVED_AT, ...overrides });

function render(
  agent: ReturnType<typeof fixtures.agent>,
  capability: AgentRestoreCapability,
): string {
  return renderToStaticMarkup(
    <ArchivedNotice
      agent={agent}
      capability={capability}
      locale="en"
      restoring={false}
      problem={null}
      onRestore={() => undefined}
    />,
  );
}

let mounted: (() => void) | undefined;
afterEach(() => {
  refresh.mockClear();
  mounted?.();
  mounted = undefined;
});

function mount(element: React.ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  mounted = () => {
    act(() => {
      root.unmount();
    });
    host.remove();
  };
  return host;
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('the Restore button', () => {
  it('shows only for an archived agent and a viewer who may restore it', () => {
    const mine = { canRestoreOwn: true, canRestoreOther: false, viewerPrincipalId: VIEWER };

    expect(render(archived({ ownerPrincipalId: VIEWER }), mine)).toContain('>Restore</button>');
    expect(render(archived({ ownerPrincipalId: 'someone-else' }), OWNER_VIEWER)).toContain(
      '>Restore</button>',
    );

    const denied = [
      render(archived({ ownerPrincipalId: 'someone-else' }), mine),
      render(archived({ ownerPrincipalId: VIEWER }), { ...NO_ONE, viewerPrincipalId: VIEWER }),
      render(archived({ ownerPrincipalId: VIEWER }), NO_ONE),
      render(archived({ ownerPrincipalId: VIEWER, builtin: 'builder' }), OWNER_VIEWER),
      render(fixtures.agent({ ownerPrincipalId: VIEWER }), OWNER_VIEWER),
    ];
    for (const html of denied) expect(html).not.toContain('<button');
  });

  it('restores through the API with no body and clears the badge', async () => {
    double.current = fetchDouble((request) =>
      request.method === 'POST'
        ? jsonResponse(200, fixtures.agent({ ownerPrincipalId: VIEWER }))
        : jsonResponse(200, archived({ ownerPrincipalId: VIEWER })),
    );
    const host = mount(<AgentArchivedNotice agentId="a-1" locale="en" capability={OWNER_VIEWER} />);
    await settle();
    expect(host.textContent).toContain('Archived');

    const button = host.querySelector('button');
    expect(button?.textContent).toBe('Restore');
    act(() => {
      button?.click();
    });
    await settle();

    const post = double.current.calls.find((call) => call.method === 'POST');
    expect(post?.url.pathname).toMatch(/\/restore$/u);
    expect(post?.init.body).toBeUndefined();
    expect(host.textContent).toBe('');
  });

  it('refreshes the whole page after a restore, so the other tabs reload', async () => {
    double.current = fetchDouble((request) =>
      request.method === 'POST'
        ? jsonResponse(200, fixtures.agent({ ownerPrincipalId: VIEWER }))
        : jsonResponse(200, archived({ ownerPrincipalId: VIEWER })),
    );
    const host = mount(<AgentArchivedNotice agentId="a-1" locale="en" capability={OWNER_VIEWER} />);
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    act(() => {
      host.querySelector('button')?.click();
    });
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the problem message when the server refuses the restore (403)', async () => {
    double.current = fetchDouble((request) =>
      request.method === 'POST'
        ? jsonResponse(403, { error: { code: 'forbidden', message: 'Your role may not do this.' } })
        : jsonResponse(200, archived({ ownerPrincipalId: VIEWER })),
    );
    const host = mount(<AgentArchivedNotice agentId="a-1" locale="en" capability={OWNER_VIEWER} />);
    await settle();
    act(() => {
      host.querySelector('button')?.click();
    });
    await settle();

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Your role may not restore this agent.',
    );
    expect(host.textContent).toContain('Archived');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('words the refusal in the console language, not the server English', async () => {
    double.current = fetchDouble((request) =>
      request.method === 'POST'
        ? jsonResponse(403, { error: { code: 'forbidden', message: 'Your role may not do this.' } })
        : jsonResponse(200, archived({ ownerPrincipalId: VIEWER })),
    );
    const host = mount(<AgentArchivedNotice agentId="a-1" locale="ja" capability={OWNER_VIEWER} />);
    await settle();
    act(() => {
      host.querySelector('button')?.click();
    });
    await settle();

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'このエージェントを復元する権限がありません。',
    );
  });
});

describe('ArchivedBadge', () => {
  it('says Archived in English and アーカイブ済み in Japanese, with the archive time on hover', () => {
    const en = renderToStaticMarkup(<ArchivedBadge archivedAt={ARCHIVED_AT} locale="en" />);
    const ja = renderToStaticMarkup(<ArchivedBadge archivedAt={ARCHIVED_AT} locale="ja" />);
    expect(en).toContain('>Archived<');
    expect(en).toContain(`title="Archived at ${ARCHIVED_AT}"`);
    expect(ja).toContain('>アーカイブ済み<');
    expect(ja).toContain(`title="アーカイブ日時: ${ARCHIVED_AT}"`);
  });
});

describe('the agent list', () => {
  it('hides archived agents until "Show archived" is ticked, then asks for ?archived=include', async () => {
    double.current = fetchDouble((request) =>
      jsonResponse(200, {
        agents: request.url.searchParams.get('archived') === 'include' ? [archived()] : [],
      }),
    );
    const host = mount(<AgentsListScreen locale="en" />);
    await settle();
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.closest('label')?.textContent).toBe('Show archived');
    expect(double.current.calls.map((call) => call.url.search)).toEqual(['']);

    act(() => {
      toggle?.click();
    });
    await settle();

    expect(double.current.calls.map((call) => call.url.search)).toEqual(['', '?archived=include']);
    expect(host.textContent).toContain('Archived');
  });
});
