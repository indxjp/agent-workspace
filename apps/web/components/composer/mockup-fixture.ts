/**
 * `ui/home.html`'s own demo content, transcribed row for row.
 *
 * ## This is a fixture. It is not data, and it must never reach a running workspace.
 *
 * The mockup demonstrates the screen with a fictional workspace: five agents, four file sets, four
 * connectors and four recent runs that belong to nobody. Shipping any of it as the content of a real
 * installation would claim capability that is not there — which is the one thing §19.5.1 rule 2
 * exists to prevent — so `app/(shell)/page.tsx` builds its props from the control plane and never
 * from this file. Nothing under `apps/web/app/` imports it, and `model.test.ts` asserts that.
 *
 * What it *is* for: the acceptance criterion "the composer, the three pickers and the Recent list
 * match `ui/home.html`" is checked by rendering the screen against the mockup's own content and
 * comparing the two side by side. That comparison needs the content to exist in a form the
 * application can render, and it needs it to stay correct — a reviewer re-running the comparison
 * later should be looking at the same rows the mockup shows.
 *
 * ## Where the transcription had to stop
 *
 * A static page has one selected agent, so `ui/home.html` prints exactly one Files panel and one
 * Connectors panel: the panels of the agent its own markup marks selected, **General**. It says
 * nothing about what the other four agents permit. A {@link ComposerAgent} carries its own permitted
 * sets, so the mockup's eight rows are attached to General and the other four agents carry none —
 * their `.d` lines gesture at sets ("Handbook + Jira", "2 connectors") that the mockup never
 * enumerates, and enumerating them here would be inventing content, not transcribing it. The one
 * field with no counterpart in the markup is `sandbox` for the four unselected agents; those strings
 * are read off each row's own `.d` line. Recorded in
 * docs/adr/W1-UI-02-mockup-content-is-a-fixture-not-data.md.
 *
 * The side effect is that the comparison shows narrowing working: General offers all eight rows,
 * and switching to any other agent empties both pickers.
 */
import type { ComposerAgent, RecentSession } from './model';

/** The four rows of the mockup's Files panel, in the mockup's order. */
const MOCKUP_FILES = [
  { id: 'contracts/2026-q3', name: 'contracts/2026-q3', detail: '3 files · 2.9 MB' },
  { id: 'handbook/', name: 'handbook/', detail: '9 files · 4.2 MB' },
  { id: 'templates/', name: 'templates/', detail: '2 files · 310 KB' },
  { id: 'report-template.docx', name: 'report-template.docx', detail: '142 KB' },
] as const;

/** The four rows of the mockup's Connectors panel, in the mockup's order. */
const MOCKUP_CONNECTORS = [
  {
    id: 'internal-search',
    name: 'Internal Search',
    detail: 'Remote URL · Bearer token · reachable',
  },
  { id: 'jira', name: 'Jira', detail: 'Remote URL · OAuth · reachable' },
  { id: 'github', name: 'GitHub', detail: 'Remote URL · API key · reachable' },
  { id: 'google-drive', name: 'Google Drive', detail: 'SSE · OAuth · not tested' },
] as const;

/**
 * The five rows of the mockup's agent panel, in the mockup's order — General first, because that is
 * the row the mockup marks selected and the one whose panels it prints.
 */
export const MOCKUP_AGENTS: readonly [ComposerAgent, ...ComposerAgent[]] = [
  {
    id: 'general',
    name: 'General',
    detail: 'Claude Sonnet 5 · read-only sandbox · no connectors',
    files: [...MOCKUP_FILES],
    connectors: [...MOCKUP_CONNECTORS],
    sandbox: 'Standard Sandbox · read-only',
    runTarget: { kind: 'unknown' },
    drivableProviders: ['anthropic', 'anthropic-compatible'],
  },
  {
    id: 'customer-support',
    name: 'Customer Support Agent',
    detail: 'Handbook + Jira · read/write · 3 skills',
    files: [],
    connectors: [],
    sandbox: 'Standard Sandbox · read/write',
    runTarget: { kind: 'unknown' },
    drivableProviders: ['anthropic', 'anthropic-compatible'],
  },
  {
    id: 'contract-review',
    name: 'Contract Review',
    detail: 'GPT‑4.1 via Azure · read-only · compatibility mode',
    files: [],
    connectors: [],
    sandbox: 'Standard Sandbox · read-only',
    runTarget: { kind: 'unknown' },
    drivableProviders: ['anthropic', 'anthropic-compatible'],
  },
  {
    id: 'invoice-triage',
    name: 'Invoice Triage',
    detail: 'Claude Haiku 4.5 · 2 connectors',
    files: [],
    connectors: [],
    sandbox: 'Standard Sandbox · read-only',
    runTarget: { kind: 'unknown' },
    drivableProviders: ['anthropic', 'anthropic-compatible'],
  },
  {
    id: 'security-review-bot',
    name: 'Security Review Bot',
    detail: 'Claude Opus 5 · Kubernetes runtime',
    files: [],
    connectors: [],
    sandbox: 'Kubernetes · read-only',
    runTarget: { kind: 'unknown' },
    drivableProviders: ['anthropic', 'anthropic-compatible'],
  },
];

/** The four rows of the mockup's Recent list, in the mockup's order. */
export const MOCKUP_RECENT: readonly RecentSession[] = [
  {
    id: 'r1',
    title: 'Q3 contract summary',
    titleBadges: [],
    meta: 'Contract Review · 3 files · 2 minutes ago',
    status: { label: 'Completed', tone: 'ok' },
    cost: '$0.08',
    href: null,
  },
  {
    id: 'r2',
    title: 'Handbook: parental leave',
    titleBadges: [],
    meta: 'Customer Support Agent · yesterday',
    status: { label: 'Completed', tone: 'ok' },
    cost: '$0.01',
    href: null,
  },
  {
    id: 'r3',
    title: 'Invoice 8842 exception',
    titleBadges: [{ label: 'Shared', tone: 'info' }],
    meta: 'Invoice Triage · 2 days ago · public link · 14 views',
    status: { label: 'Completed', tone: 'ok' },
    cost: '$0.02',
    href: null,
  },
  {
    id: 'r4',
    title: 'Draft weekly report',
    titleBadges: [],
    meta: 'Weekly Report Writer · 4 days ago',
    status: { label: 'Interrupted', tone: 'warn' },
    cost: '$0.06',
    href: null,
  },
];
