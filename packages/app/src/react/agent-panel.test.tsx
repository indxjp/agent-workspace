import { badgeForRunStatus } from '@indx-workspace/react/run-model';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { enumOf, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import type { AgentPanelClient } from './agent-panel-client.js';
import {
  agentPanelReducer,
  INITIAL_AGENT_PANEL_STATE,
  type AgentPanelState,
  type FrameContext,
} from './agent-panel-model.js';
import { AgentPanel, AgentPanelRunState, type AgentPanelApprovalProps } from './agent-panel.js';
import { appStrings } from './locale.js';

const ticket = defineResource({
  name: 'ticket',
  fields: { title: text({ max: 200 }), status: enumOf(['open', 'closed'], { default: 'open' }) },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: ['status'] },
});

const ID = '0f5c2a8e-1b2c-4d3e-8f90-123456789abc';
const RUN = '33333333-3333-4333-8333-333333333333';
const CALL = { toolName: 'ticket_update', canonicalCall: '{"assignee":"Net"}' };
const agents = [
  { name: 'triage', label: 'Triage' },
  { name: 'writer', label: 'Reply <writer>' },
];

/** A client whose answers never come: the server render draws the state before the first one. */
const pending: AgentPanelClient = {
  start: () => new Promise(() => undefined),
  get: () => new Promise(() => undefined),
  decide: () => new Promise(() => undefined),
  follow: () => new Promise(() => undefined),
};

const context: FrameContext = {
  agent: { initials: 'TR', name: 'Triage' },
  badge: (status) => badgeForRunStatus(status),
};

/** A run that waits for `CALL`, as the panel holds it once it read the run. */
const awaiting: AgentPanelState = [
  {
    type: 'send' as const,
    messageId: 'm1',
    prompt: 'classify and route',
    you: { initials: 'YO', name: 'You' },
    title: 'Triage',
  },
  {
    type: 'started' as const,
    run: { id: RUN, status: 'awaiting_approval' as const, pendingApproval: null, error: null },
    context,
  },
  {
    type: 'run' as const,
    run: { id: RUN, status: 'awaiting_approval' as const, pendingApproval: CALL, error: null },
    context,
  },
].reduce(agentPanelReducer, INITIAL_AGENT_PANEL_STATE);

function draw(locale: 'en' | 'ja' = 'en'): string {
  return renderToStaticMarkup(
    <AgentPanel resource={ticket} recordId={ID} agents={agents} client={pending} locale={locale} />,
  );
}

/** Every `id` the markup defines, and every `for` / `aria-labelledby` it points at. */
function idsOf(html: string): { defined: string[]; referenced: string[] } {
  return {
    defined: [...html.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1] ?? ''),
    referenced: [...html.matchAll(/\s(?:for|aria-labelledby)="([^"]+)"/gu)].map((m) => m[1] ?? ''),
  };
}

describe('AgentPanel', () => {
  it('draws a labelled section, a labelled agent picker and a labelled prompt with send', () => {
    const html = draw();
    expect(html).toMatch(/<section class="aw-app-panel" aria-labelledby="[^"]+-heading">/u);
    expect(html).toContain('>Ask an agent</h2>');
    expect(html).toMatch(
      /<label for="[^"]+-agent" class="aw-app-label">Agent<\/label><select id="[^"]+-agent"/u,
    );
    expect(html).toMatch(
      /<label for="[^"]+-prompt" class="aw-app-label">What should the agent do with this record\?<\/label><textarea id="[^"]+-prompt"[^>]*required=""/u,
    );
    expect(html).toContain('<option value="triage" selected="">Triage</option>');
    // The agent's label is a text node: it cannot inject markup.
    expect(html).toContain('Reply &lt;writer&gt;');
    expect(html).toContain(
      '<button type="submit" class="aw-app-button aw-app-primary">Send</button>',
    );
    expect(html).toContain('aria-label="Conversation with the agent"');
    expect(html).toContain('Choose an agent and tell it what to do with this record.');
    const { defined, referenced } = idsOf(html);
    expect(new Set(defined).size).toBe(defined.length);
    for (const target of referenced) expect(defined).toContain(target);
  });

  it('speaks Japanese', () => {
    const html = draw('ja');
    expect(html).toContain('>エージェントに依頼</h2>');
    expect(html).toContain('>エージェント</label>');
    expect(html).toContain('>送信</button>');
    expect(html).not.toContain('Ask an agent');
  });

  it('pre-fills the prompt and the agent when a page action opens it (#1521)', () => {
    const html = renderToStaticMarkup(
      <AgentPanel
        resource={ticket}
        recordId={ID}
        agents={agents}
        client={pending}
        initialPrompt={'Rewrite page <x> with page_update'}
        initialAgent="writer"
      />,
    );
    expect(html).toMatch(
      /<textarea id="[^"]+-prompt"[^>]*>Rewrite page &lt;x&gt; with page_update<\/textarea>/u,
    );
    expect(html).toContain('<option value="writer" selected="">Reply &lt;writer&gt;</option>');
    expect(html).toContain('<option value="triage">Triage</option>');
  });

  it('is unchanged without them: an empty prompt and the first agent (#1521)', () => {
    const html = draw();
    expect(html).toMatch(/<textarea id="[^"]+-prompt"[^>]*><\/textarea>/u);
    expect(html).toContain('<option value="triage" selected="">Triage</option>');
    const unknown = renderToStaticMarkup(
      <AgentPanel
        resource={ticket}
        recordId={ID}
        agents={agents}
        client={pending}
        initialAgent="nobody"
      />,
    );
    expect(unknown).toContain('<option value="triage" selected="">Triage</option>');
  });
});

describe('AgentPanelRunState', () => {
  const strings = appStrings('en').agentPanel;
  const noop = (): void => undefined;

  it('draws renderApproval with the call while the run awaits approval', () => {
    const seen: AgentPanelApprovalProps[] = [];
    const html = renderToStaticMarkup(
      <AgentPanelRunState
        state={awaiting}
        strings={strings}
        problem={null}
        onDecide={noop}
        onCheckAgain={noop}
        renderApproval={(props) => {
          seen.push(props);
          return <button type="button">Approve {props.call.toolName}</button>;
        }}
      />,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ call: CALL, pending: false, problem: null });
    expect(html).toContain('<button type="button">Approve ticket_update</button>');
    expect(html).toContain('<span class="aw-app-badge" data-tone="warn">Awaiting approval</span>');
    expect(html).not.toContain(strings.awaitingInConsole);
  });

  it('without renderApproval, says to decide in Agent Workspace and offers to check again', () => {
    const html = renderToStaticMarkup(
      <AgentPanelRunState
        state={awaiting}
        strings={appStrings('ja').agentPanel}
        problem={null}
        onDecide={noop}
        onCheckAgain={noop}
        renderApproval={undefined}
      />,
    );
    expect(html).toContain('role="note"');
    expect(html).toContain(appStrings('ja').agentPanel.awaitingInConsole);
    expect(html).toContain('>再確認</button>');
    expect(html).toContain('>承認待ち</span>');
  });

  it("shows a failed run's notice as an alert", () => {
    const failed = agentPanelReducer(awaiting, {
      type: 'frame',
      frame: { kind: 'run-failed', data: { status: 'failed', message: 'The run failed.' } },
      context,
    });
    const html = renderToStaticMarkup(
      <AgentPanelRunState
        state={failed}
        strings={strings}
        problem={null}
        onDecide={noop}
        onCheckAgain={noop}
        renderApproval={undefined}
      />,
    );
    expect(html).toContain(
      '<div class="aw-app-alert" role="alert"><p class="aw-app-alert-heading">The agent could not finish.</p><p>The run failed.</p></div>',
    );
  });
});
