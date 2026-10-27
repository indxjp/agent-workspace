/**
 * The two behavioural rules of §19.5.1 that this task's acceptance criterion names, asserted
 * directly: **the pickers narrow, never widen**, and **switching agent starts a new session**.
 *
 * The layout half of the criterion ("the composer, the three pickers and the Recent list match
 * `ui/home.html`") is a visual comparison and is evidenced in the pull request, not here. What is
 * here is the half a screenshot cannot show.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MOCKUP_AGENTS, MOCKUP_RECENT } from './mockup-fixture';
import {
  findAgent,
  initialSession,
  offeredBy,
  pinnedAgentFrom,
  pinnedChatHref,
  selectAgent,
  selectedChips,
  selectedIn,
  startSession,
  toggleOption,
  type ComposerAgent,
  type ComposerSession,
} from './model';

const GENERAL = MOCKUP_AGENTS[0];

/** An agent that permits one file and nothing else. Its emptiness is the point. */
const LOCKED_DOWN: ComposerAgent = {
  id: 'locked',
  name: 'Locked Down',
  detail: 'no files, no connectors',
  files: [],
  connectors: [],
  sandbox: 'Standard Sandbox · read-only',
  runTarget: { kind: 'unknown' },
  drivableProviders: ['anthropic', 'anthropic-compatible'],
};

function sessionOn(agent: ComposerAgent): ComposerSession {
  return startSession(agent, 0);
}

describe('rule 2 — a picker offers only what the selected agent already permits', () => {
  it('offers exactly the selected agent own sets, and no union across agents', () => {
    expect(offeredBy(GENERAL, 'files').map((f) => f.id)).toEqual([
      'contracts/2026-q3',
      'handbook/',
      'templates/',
      'report-template.docx',
    ]);
    expect(offeredBy(GENERAL, 'connectors').map((c) => c.id)).toEqual([
      'internal-search',
      'jira',
      'github',
      'google-drive',
    ]);

    // Every other agent in the same list offers nothing, so no agent inherits another's rows.
    for (const agent of MOCKUP_AGENTS.slice(1)) {
      expect(offeredBy(agent, 'files')).toEqual([]);
      expect(offeredBy(agent, 'connectors')).toEqual([]);
    }
  });

  it('refuses an option the selected agent does not permit, and names it', () => {
    const session = sessionOn(LOCKED_DOWN);
    const refused = toggleOption(LOCKED_DOWN, session, 'files', 'contracts/2026-q3');

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toContain('does not permit');
    expect(refused.reason).toContain('contracts/2026-q3');
  });

  it('refuses an option that belongs to a different agent in the same workspace', () => {
    // The strongest form of the rule: the id is real, another agent offers it, and it is still
    // refused because *this* agent does not.
    const session = sessionOn(LOCKED_DOWN);
    for (const option of offeredBy(GENERAL, 'connectors')) {
      expect(toggleOption(LOCKED_DOWN, session, 'connectors', option.id).ok).toBe(false);
    }
  });

  it('refuses a malformed option id rather than letting it fall through', () => {
    const session = sessionOn(GENERAL);
    for (const bad of [undefined, null, '', 0, {}, ['handbook/']]) {
      const result = toggleOption(GENERAL, session, 'files', bad);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses to narrow a session against an agent it does not run as', () => {
    const session = sessionOn(GENERAL);
    const result = toggleOption(LOCKED_DOWN, session, 'files', 'contracts/2026-q3');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('narrowed against');
  });

  it('accepts an option the agent does permit, and toggles it off again', () => {
    const opened = sessionOn(GENERAL);
    const on = toggleOption(GENERAL, opened, 'files', 'handbook/');
    expect(on.ok).toBe(true);
    if (!on.ok) throw new Error('unreachable');
    expect(selectedIn(on.session, 'files')).toEqual(['handbook/']);

    const off = toggleOption(GENERAL, on.session, 'files', 'handbook/');
    expect(off.ok).toBe(true);
    if (!off.ok) throw new Error('unreachable');
    expect(selectedIn(off.session, 'files')).toEqual([]);
  });

  it('draws chips only from the selected agent own options', () => {
    const opened = sessionOn(GENERAL);
    const withFile = toggleOption(GENERAL, opened, 'files', 'contracts/2026-q3');
    if (!withFile.ok) throw new Error('unreachable');
    const withBoth = toggleOption(GENERAL, withFile.session, 'connectors', 'internal-search');
    if (!withBoth.ok) throw new Error('unreachable');

    expect(selectedChips(GENERAL, withBoth.session).map((chip) => chip.name)).toEqual([
      'contracts/2026-q3',
      'Internal Search',
    ]);

    // A session carrying ids the agent does not permit — which `toggleOption` cannot produce, but a
    // stale render or a restored draft could — names no capability at all.
    const forged: ComposerSession = {
      key: 0,
      agentId: LOCKED_DOWN.id,
      files: ['contracts/2026-q3'],
      connectors: ['jira'],
    };
    expect(selectedChips(LOCKED_DOWN, forged)).toEqual([]);
  });
});

describe('rule 4 — switching the agent starts a new session', () => {
  it('mints a new key and carries no selection over', () => {
    const opened = sessionOn(GENERAL);
    const narrowed = toggleOption(GENERAL, opened, 'files', 'handbook/');
    if (!narrowed.ok) throw new Error('unreachable');
    const connected = toggleOption(GENERAL, narrowed.session, 'connectors', 'jira');
    if (!connected.ok) throw new Error('unreachable');

    const switched = selectAgent(MOCKUP_AGENTS, connected.session, 'contract-review');
    expect(switched.ok).toBe(true);
    if (!switched.ok) throw new Error('unreachable');

    expect(switched.newSession).toBe(true);
    expect(switched.session.key).not.toBe(connected.session.key);
    expect(switched.session.agentId).toBe('contract-review');
    expect(switched.session.files).toEqual([]);
    expect(switched.session.connectors).toEqual([]);
  });

  it('gives a different key each time, so two switches are two sessions', () => {
    const first = sessionOn(GENERAL);
    const second = selectAgent(MOCKUP_AGENTS, first, 'jira-less');
    expect(second.ok).toBe(false);

    const away = selectAgent(MOCKUP_AGENTS, first, 'invoice-triage');
    if (!away.ok) throw new Error('unreachable');
    const back = selectAgent(MOCKUP_AGENTS, away.session, 'general');
    if (!back.ok) throw new Error('unreachable');

    expect(new Set([first.key, away.session.key, back.session.key]).size).toBe(3);
    expect(back.newSession).toBe(true);
  });

  it('re-choosing the agent already selected is not a switch and keeps the selection', () => {
    const opened = sessionOn(GENERAL);
    const narrowed = toggleOption(GENERAL, opened, 'files', 'templates/');
    if (!narrowed.ok) throw new Error('unreachable');

    const again = selectAgent(MOCKUP_AGENTS, narrowed.session, 'general');
    if (!again.ok) throw new Error('unreachable');

    expect(again.newSession).toBe(false);
    expect(again.session).toBe(narrowed.session);
    expect(selectedIn(again.session, 'files')).toEqual(['templates/']);
  });

  it('refuses an unknown agent by name instead of silently keeping the current one', () => {
    const opened = sessionOn(GENERAL);
    for (const bad of [undefined, null, '', 42, 'no-such-agent']) {
      const result = selectAgent(MOCKUP_AGENTS, opened, bad);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain('is available to this workspace');
    }
  });
});

describe('the opening session', () => {
  it('is the first agent when there is one', () => {
    expect(initialSession(MOCKUP_AGENTS)?.agentId).toBe('general');
  });

  it('is null when the workspace offers none — never a placeholder agent', () => {
    expect(initialSession([])).toBeNull();
    expect(findAgent([], 'general')).toBeNull();
  });
});

describe('the mockup fixture stays a fixture', () => {
  const APP_DIR = join(import.meta.dirname, '..', '..', 'app');

  function filesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) found.push(...filesUnder(full));
      else if (/\.tsx?$/u.test(entry)) found.push(full);
    }
    return found;
  }

  it('is imported by no file under apps/web/app', () => {
    // The mockup's five agents and four runs belong to a fictional workspace. If a route ever
    // imports them, this screen starts claiming capability that is not there — §19.5.1 rule 2 in
    // its most literal form. Derived from the tree rather than asserted about it.
    const routes = filesUnder(APP_DIR);
    expect(routes.length).toBeGreaterThan(0);

    const offenders = routes.filter((file) =>
      readFileSync(file, 'utf8').includes('mockup-fixture'),
    );
    expect(offenders).toEqual([]);
  });

  it('transcribes the mockup Recent rows in the mockup order', () => {
    expect(MOCKUP_RECENT.map((run) => run.title)).toEqual([
      'Q3 contract summary',
      'Handbook: parental leave',
      'Invoice 8842 exception',
      'Draft weekly report',
    ]);
    expect(MOCKUP_RECENT.map((run) => run.status.label)).toEqual([
      'Completed',
      'Completed',
      'Completed',
      'Interrupted',
    ]);
  });
});

describe('a chat pinned to an agent version', () => {
  const AGENT = '0b7f4f0e-6a38-4d6c-9d0e-0c7a1f5a8c11';

  it('[US-BLD-05][unit][web] reads a well-formed pin and round-trips the link it builds', () => {
    expect(pinnedAgentFrom({ agent: AGENT, version: '2' })).toEqual({ agentId: AGENT, version: 2 });
    const url = new URL(pinnedChatHref({ agentId: AGENT, version: 2 }), 'http://x');
    expect(url.pathname).toBe('/');
    expect(pinnedAgentFrom(Object.fromEntries(url.searchParams))).toEqual({
      agentId: AGENT,
      version: 2,
    });
  });

  it.each([
    ['no parameters', {}],
    ['no version', { agent: AGENT }],
    ['no agent', { version: '2' }],
    ['an agent that is not a uuid', { agent: 'general', version: '2' }],
    ['a zero version', { agent: AGENT, version: '0' }],
    ['a negative version', { agent: AGENT, version: '-1' }],
    ['a fractional version', { agent: AGENT, version: '1.5' }],
    ['a non-numeric version', { agent: AGENT, version: 'latest' }],
    ['a version past the contract maximum', { agent: AGENT, version: '2147483648' }],
    ['a version with leading zeros', { agent: AGENT, version: '02' }],
    ['a repeated agent', { agent: [AGENT, AGENT], version: '2' }],
    ['a repeated version', { agent: AGENT, version: ['1', '2'] }],
  ])('[US-BLD-05][unit][web] ignores the pin for %s', (_name, params) => {
    expect(pinnedAgentFrom(params)).toBeNull();
  });
});
