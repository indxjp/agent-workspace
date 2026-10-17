import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RUNTIME_OPTIONS, runtimeProfileDraftFor } from './model';
import { RuntimesScreen, type RuntimeScreenEntry } from './runtimes-screen';

/** The row `installDriverRegistry` produces for an egress-enabled Azure preview pool. */
const ACA_POOL_ENTRY: RuntimeScreenEntry = {
  id: 'aca-sessions',
  label: 'Azure Container Apps dynamic sessions',
  connectionExists: true,
  imageReachable: true,
  testPassed: true,
  state: 'enabled',
  reason: null,
  networkPolicies: ['open'],
};

describe('RuntimesScreen', () => {
  it('drafts the policy the listed ACA entry reports, so Save cannot unrun the profile', () => {
    // The Save click cannot be driven without a DOM (see team/remove-dialog.test.tsx), so the
    // draft the button submits is asserted at the function the handler calls with the listed
    // entry — the same entry the screen renders below.
    expect(runtimeProfileDraftFor(ACA_POOL_ENTRY)).toEqual({
      name: 'aca-sessions default',
      driver: 'aca-sessions',
      networkPolicy: 'open',
      filesystem: 'read-write',
    });
  });

  it('describes the ACA pool by what fixes its policy, never as egress-disabled by default', () => {
    const html = renderToStaticMarkup(createElement(RuntimesScreen, { entries: [ACA_POOL_ENTRY] }));
    expect(html).toContain('network policy fixed when the pool is created');
    expect(html).not.toContain('egress disabled by default');
  });

  it('shows a runtime that refuses every network policy as refusing every run (ADR-0131)', () => {
    const refusal = 'cloudflare-sandbox refuses every network policy (ADR-0131).';
    const html = renderToStaticMarkup(
      createElement(RuntimesScreen, {
        entries: [
          {
            ...ACA_POOL_ENTRY,
            id: 'cloudflare-sandbox',
            label: 'Cloudflare Sandbox',
            testPassed: false,
            networkPolicies: null,
            refusal,
          },
        ],
      }),
    );
    expect(html).toContain('Refuses every run');
    expect(html).toContain(refusal);
  });

  it('lets an unverified but connected and reachable runtime run its first Test Runtime', () => {
    const html = renderToStaticMarkup(
      createElement(RuntimesScreen, {
        entries: [
          {
            id: 'docker',
            label: 'Docker',
            connectionExists: true,
            imageReachable: true,
            testPassed: false,
            state: 'disabled',
            reason: 'Test Runtime has not passed for this runtime.',
            networkPolicies: null,
          },
        ],
      }),
    );
    const button = /<button[^>]*>Test Runtime<\/button>/u.exec(html)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toMatch(/\sdisabled(?:=|>)/u);
  });

  it('shows every section 14.9 failure combination disabled with its registry reason', () => {
    for (const connectionExists of [false, true]) {
      for (const imageReachable of [false, true]) {
        for (const testPassed of [false, true]) {
          // The web's rule (`createWebRuntimeRegistry`): only a missing connection or an unreachable
          // image disables a driver; a lapsed Test Runtime pass is re-verified at run time.
          const reasons = [
            ...(connectionExists ? [] : ['No runtime connection is configured.']),
            ...(imageReachable ? [] : ['The runtime image is not reachable.']),
          ];
          const state = reasons.length === 0 ? 'enabled' : 'disabled';
          const reason = reasons.join(' ') || null;
          const entry: RuntimeScreenEntry = {
            id: 'docker',
            label: 'Docker',
            connectionExists,
            imageReachable,
            testPassed,
            state,
            reason,
            networkPolicies: null,
          };
          const html = renderToStaticMarkup(createElement(RuntimesScreen, { entries: [entry] }));
          expect(html).toContain('Docker');
          if (reason !== null) {
            expect(reason.length).toBeGreaterThan(0);
            expect(html).toContain(reason);
            expect(html).toMatch(/<button[^>]*disabled[^>]*aria-pressed="true"/u);
          } else {
            expect(html).not.toContain('Test Runtime has not passed for this runtime.');
          }
        }
      }
    }
  });

  it('offers every provider sandbox driver, so each can run Test Runtime from the page', () => {
    const html = renderToStaticMarkup(createElement(RuntimesScreen, { entries: [] }));
    for (const id of ['vercel-sandbox', 'cloudflare-sandbox', 'external']) {
      const option = RUNTIME_OPTIONS.find((candidate) => candidate.id === id);
      expect(option).toBeDefined();
      expect(html).toContain(option?.label);
    }
    expect(html).toContain('Vercel Sandbox');
  });

  it('renders the unverified badge and exact blocking/warning comparison copy', () => {
    const html = renderToStaticMarkup(createElement(RuntimesScreen, { entries: [] }));
    expect(html).toContain('Unverified');
    expect(html).toContain('Changing runtime: Docker → Azure Container Apps dynamic sessions');
    expect(html).toContain('⚠ Domain allowlist is not supported on this runtime.');
    expect(html).toContain('✕ This agent uses a local command connector (Filesystem MCP).');
    expect(html).toMatch(/>Save<\/button>/u);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save<\/button>/u);
    const positions = RUNTIME_OPTIONS.map((option) => html.indexOf(option.label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});
