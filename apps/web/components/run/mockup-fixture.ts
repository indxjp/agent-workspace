/**
 * `ui/agent-run.html`'s own demo content, line for line.
 *
 * ## This is a fixture. It is not data, and it must never reach a running workspace.
 *
 * The mockup demonstrates the screen with a fictional session: an agent called "Customer Support
 * Agent", a container id, three supplier contracts, an internal MCP endpoint, a cost and a written
 * output file. None of it belongs to any installation. Shipping it as the content of a real screen
 * would be the failure ADR-0015 names — a run asserted because nothing contradicted it — so nothing
 * under `apps/web/app/` imports this file, and `run-view.test.ts` asserts that from the tree rather
 * than trusting it.
 *
 * What it *is* for: this task's acceptance is a side-by-side comparison against
 * `ui/agent-run.html`, and that comparison needs the mockup's content in a form the application can
 * render. Keeping it here rather than inline in a test means one transcription, checked once.
 *
 * ## Two things the mockup shows over time, and which moment is transcribed
 *
 * `ui/agent-run.html` ends with a small script that, after 2.6 seconds, finishes the pending step,
 * reveals the answer and flips the badge to "Completed · 23 s · $0.08". The page therefore has two
 * states and a transcription has to pick one.
 *
 * {@link MOCKUP_RUN} is the **first** state — the run still in flight, with "Preparing summary…"
 * spinning and no answer yet. That is the state §19 is actually about ("the user should see what it
 * is doing"), and it is the only one of the two that exercises the running-step marker.
 * {@link MOCKUP_RUN_COMPLETED} is the state after the script runs, and exists so the comparison can
 * be made against both. Neither is more real than the other; both are the mockup.
 */
import {
  mono,
  plain,
  text,
  type ActivityStep,
  type EventLine,
  type Run,
  type UnbuiltAction,
} from '@indx-workspace/react/run-model';

const AYA = { initials: 'AI', name: 'Aya Ito' } as const;
const AGENT = { initials: 'CS', name: 'Customer Support Agent' } as const;

const INTERRUPT: UnbuiltAction = { id: 'interrupt', label: 'Interrupt', primary: false };
const SESSIONS: UnbuiltAction = { id: 'sessions', label: 'Sessions', primary: false };

function done(id: string, label: string, tool: string | null, duration: string): ActivityStep {
  return { id, state: 'done', label, tool, duration };
}

const READS: readonly ActivityStep[] = [
  done('read-01', 'Read', 'contracts/2026-q3/agreement-01.pdf', '0.6 s'),
  done('read-02', 'Read', 'contracts/2026-q3/agreement-02.pdf', '0.5 s'),
  done('read-03', 'Read', 'contracts/2026-q3/agreement-03.pdf', '0.7 s'),
];

const SEARCH = done('search', 'Internal Search', 'mcp__internalSearch.query', '1.2 s');

const PENDING: ActivityStep = {
  id: 'pending',
  state: 'running',
  label: 'Preparing summary…',
  tool: null,
  duration: '—',
};

const WROTE = done('wrote', 'Wrote', 'output/contract-review-2026-q3.md', '3.4 s');

function line(id: string, time: string, event: string, detail: string): EventLine {
  return { id, time, event, detail };
}

const SDK_EVENTS: readonly EventLine[] = [
  line(
    'e01',
    '14:32:04.118',
    'system.init',
    'session_id=sess_8f21c4 model=claude-sonnet-5 cwd=/workspace tools=7 mcp_servers=2',
  ),
  line('e02', '14:32:04.402', 'assistant.text', '"Reviewing the uploaded files…"'),
  line(
    'e03',
    '14:32:04.655',
    'tool_use.Read',
    '{"file_path":"/workspace/contracts/2026-q3/agreement-01.pdf"}',
  ),
  line('e04', '14:32:05.201', 'tool_result.Read', 'ok · 18 pages · 42.1k characters'),
  line(
    'e05',
    '14:32:05.244',
    'tool_use.Read',
    '{"file_path":"/workspace/contracts/2026-q3/agreement-02.pdf"}',
  ),
  line('e06', '14:32:05.760', 'tool_result.Read', 'ok · 11 pages · 26.8k characters'),
  line(
    'e07',
    '14:32:05.801',
    'tool_use.Read',
    '{"file_path":"/workspace/contracts/2026-q3/agreement-03.pdf"}',
  ),
  line('e08', '14:32:06.480', 'tool_result.Read', 'ok · 9 pages · 19.3k characters'),
  line(
    'e09',
    '14:32:06.512',
    'mcp.request',
    'internalSearch.query {"q":"standard payment terms clause set","limit":5}',
  ),
  line(
    'e10',
    '14:32:07.744',
    'mcp.response',
    '5 results · 1.2 s · https://mcp.meridian.internal/search',
  ),
  line(
    'e11',
    '14:32:07.902',
    'assistant.thinking',
    'redacted by workspace policy (thinking is not stored)',
  ),
  line(
    'e12',
    '14:32:11.360',
    'tool_use.Write',
    '{"file_path":"/workspace/output/contract-review-2026-q3.md"}',
  ),
  line('e13', '14:32:11.402', 'tool_result.Write', 'ok · 6.1 KB written'),
  line(
    'e14',
    '14:32:26.918',
    'result',
    'status=completed turns=6 duration_ms=22800 cost_usd=0.0812',
  ),
];

const RUNTIME_EVENTS: readonly EventLine[] = [
  line(
    'r01',
    '14:32:02.004',
    'runtime.create',
    'driver=docker profile=Standard Sandbox image=agent-workspace/runtime@sha256:9f2c…4b1e',
  ),
  line(
    'r02',
    '14:32:02.918',
    'runtime.ready',
    'container=aw-sess-8f21c4 cpu=1 mem=1024Mi net=agent-egress (allowlist: gateway, mcp.meridian.internal, meridian.atlassian.net)',
  ),
  line('r03', '14:32:03.101', 'files.hydrate', '12 objects · 4.5 MB → /workspace'),
  line(
    'r04',
    '14:32:03.640',
    'skills.materialize',
    '.claude/skills/customer-support, document-writer, invoice-review',
  ),
  line(
    'r05',
    '14:32:27.010',
    'files.collect',
    '/workspace/output · 1 object · 6.1 KB → object storage',
  ),
  line('r06', '14:32:27.455', 'runtime.destroy', 'container removed · volume retained 24 h'),
];

const TECHNICAL: Run['technical'] = {
  sdkEvents: SDK_EVENTS,
  sdkEventsNote:
    'Raw Claude Agent SDK event stream, delivered to this page over SSE. Hidden by default.',
  usageStats: [
    { id: 'input', label: 'Input tokens', value: '11 940' },
    { id: 'output', label: 'Output tokens', value: '2 264' },
    { id: 'cache', label: 'Cache read', value: '8 512' },
    { id: 'turns', label: 'Turns', value: '6' },
    { id: 'cost', label: 'Cost', value: '$0.08' },
  ],
  usageFacts: [
    {
      term: 'Provider',
      detail: 'Anthropic',
      note: [text('· via gateway '), mono('http://gateway:4000')],
      badge: null,
      mono: false,
    },
    { term: 'Model', detail: 'claude-sonnet-5', note: null, badge: null, mono: true },
    {
      term: 'Prompt caching',
      detail: '',
      note: plain('8 512 tokens read from cache'),
      badge: { label: 'Used', tone: 'ok', dot: false },
      mono: false,
    },
    { term: 'Budget', detail: '$0.08 of $1.50', note: null, badge: null, mono: false },
  ],
  runtimeEvents: RUNTIME_EVENTS,
};

const RAIL: Run['rail'] = [
  {
    kind: 'facts',
    id: 'this-run',
    title: 'This run',
    facts: [
      {
        term: 'Status',
        detail: '',
        note: null,
        badge: { label: 'Running', tone: 'ok', dot: true },
      },
      { term: 'Model', detail: 'Claude Sonnet 5', note: null, badge: null },
      {
        term: 'Runtime',
        detail: 'Standard Sandbox',
        note: [text('Docker · container '), mono('aw-sess-8f21c4')],
        badge: null,
      },
      { term: 'Started by', detail: 'Aya Ito', note: null, badge: null },
      { term: 'Turns', detail: '6 of 24', note: null, badge: null },
      { term: 'Cost', detail: '$0.08 of $1.50', note: null, badge: null },
    ],
  },
  {
    kind: 'groups',
    id: 'in-use',
    title: 'In use',
    groups: [
      { label: 'Files', items: ['contracts/2026-q3/', 'handbook/', 'output/'] },
      { label: 'Skills', items: ['customer-support', 'document-writer', 'invoice-review'] },
      { label: 'Connectors', items: ['internalSearch', 'jira'] },
    ],
  },
  {
    kind: 'files',
    id: 'output-files',
    title: 'Output files',
    files: [
      {
        id: 'contract-review',
        title: 'contract-review-2026-q3.md',
        meta: '6.1 KB · written 12 s ago',
        action: { id: 'download', label: 'Download', primary: false },
      },
    ],
    footnote: 'Only paths marked persistent are kept when the sandbox is destroyed.',
  },
];

const FOLLOW_UP: Run['followUp'] = {
  placeholder: 'Ask a follow-up. The session is resumed, so the agent still has the context above.',
  actions: [
    { id: 'attach', label: 'Attach file', primary: false },
    { id: 'resume', label: 'Resume another session', primary: false },
  ],
  status: 'Claude Sonnet 5 · $0.08 spent of $1.50',
};

const QUESTION = [
  text('Prepare a summary of the three supplier contracts in '),
  mono('contracts/2026-q3/'),
  text(', and tell me which ones deviate from our standard payment terms.'),
];

/** The session as `ui/agent-run.html` first paints it: still running, no answer yet. */
export const MOCKUP_RUN: Run = {
  heading: {
    title: 'Customer Support Agent',
    subtitle: 'Session sess_8f21c4 · started 3 minutes ago · Claude Sonnet 5 · Standard Sandbox',
    status: { label: 'Running', tone: 'ok', dot: true },
    actions: [INTERRUPT, SESSIONS],
  },
  messages: [
    { kind: 'user', id: 'm1', speaker: AYA, paragraphs: [QUESTION] },
    {
      kind: 'agent',
      id: 'm2',
      speaker: AGENT,
      blocks: [
        { kind: 'prose', paragraphs: [plain('Reviewing the uploaded files…')] },
        { kind: 'activity', steps: READS },
        {
          kind: 'prose',
          paragraphs: [
            plain('Searching the internal contract database for our standard clause set…'),
          ],
        },
        { kind: 'activity', steps: [SEARCH, PENDING] },
      ],
    },
  ],
  technical: TECHNICAL,
  rail: RAIL,
  followUp: FOLLOW_UP,
  failure: null,
};

/** The same session after the mockup's own script runs: the answer revealed, the badge flipped. */
export const MOCKUP_RUN_COMPLETED: Run = {
  ...MOCKUP_RUN,
  // The mockup's script flips the rail's Status row as well as the header badge.
  rail: RAIL.map((card) =>
    card.kind === 'facts' && card.id === 'this-run'
      ? {
          ...card,
          facts: card.facts.map((fact) =>
            fact.term === 'Status'
              ? { ...fact, badge: { label: 'Completed', tone: 'ok' as const, dot: false } }
              : fact,
          ),
        }
      : card,
  ),
  heading: {
    ...MOCKUP_RUN.heading,
    status: { label: 'Completed · 23 s · $0.08', tone: 'ok', dot: false },
    actions: [{ id: 'interrupt', label: 'Run again', primary: false }, SESSIONS],
  },
  messages: [
    MOCKUP_RUN.messages[0],
    {
      kind: 'agent',
      id: 'm2',
      speaker: AGENT,
      blocks: [
        { kind: 'prose', paragraphs: [plain('Reviewing the uploaded files…')] },
        { kind: 'activity', steps: READS },
        {
          kind: 'prose',
          paragraphs: [
            plain('Searching the internal contract database for our standard clause set…'),
          ],
        },
        { kind: 'activity', steps: [SEARCH, WROTE] },
        {
          kind: 'prose',
          paragraphs: [
            [text('**Summary of the three Q3 supplier contracts**')],
            [
              text('**1. Kobayashi Precision Parts — agreement-01.**'),
              text(
                ' Two-year supply agreement, ¥48M annual cap, net 30 payment terms, standard limitation of liability. Matches the standard clause set.',
              ),
            ],
            [
              text('**2. Nordwind Logistics — agreement-02.**'),
              text(' One-year framework, indexed fuel surcharge, '),
              text('**net 60 payment terms**'),
              text(
                '. This deviates from our standard net 30 and shifts about ¥6M of working capital per quarter.',
              ),
            ],
            [
              text('**3. Tanaka Tooling — agreement-03.**'),
              text(' Renewal, ¥12M cap, net 30, but the '),
              text('**termination-for-convenience clause is missing**'),
              text(' — only termination for cause is included.'),
            ],
            [
              text('**Deviations to review:**'),
              text(
                ' agreement-02 (payment terms) and agreement-03 (termination). I have written the full comparison to ',
              ),
              text('`output/contract-review-2026-q3.md`'),
              text('.'),
            ],
          ],
        },
      ],
    },
  ],
};
