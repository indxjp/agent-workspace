import { describe, expect, it } from 'vitest';
import { specSections } from './inventory-support.js';
import { specRoutes, mandateFaults } from './route-specification.js';
import { routeShape } from './route-shape.js';

describe('spec §34 is a shape rule, and an extra route cites its mandate', () => {
  // ADR-0026, proved on fixtures. The live declarations are checked by the gate above; these
  // establish that the checks the gate ran can actually refuse something.
  const spec = specRoutes();
  const sections = specSections();

  it('refuses a route §34 does not print when it carries no mandate', () => {
    const faults = mandateFaults(
      [{ method: 'POST', path: '/api/secrets', owner: 'W2-CP-02', landed: false }],
      spec,
      sections,
    );
    expect(faults).toEqual([
      'POST /api/secrets (W2-CP-02): spec §34 does not print this route and it carries no mandate. ' +
        'Cite the section that requires the capability — ADR-0026 decision 2.',
    ]);
  });

  it('accepts the same route once it cites a section the specification really has', () => {
    expect(
      mandateFaults(
        [
          {
            method: 'POST',
            path: '/api/secrets',
            owner: 'W2-CP-02',
            landed: false,
            mandate: { section: '23', because: 'Secrets are created and referenced by name.' },
          },
        ],
        spec,
        sections,
      ),
    ).toEqual([]);
  });

  it('refuses a mandate citing a section docs/spec.md does not have', () => {
    const faults = mandateFaults(
      [
        {
          method: 'POST',
          path: '/api/secrets',
          owner: 'W2-CP-02',
          landed: false,
          mandate: { section: '61', because: 'Invented, and nothing would have said so.' },
        },
      ],
      spec,
      sections,
    );
    expect(faults).toEqual([
      'POST /api/secrets (W2-CP-02): cites §61, which is not a heading in docs/spec.md. A citation ' +
        'that cannot be looked up is not a mandate.',
    ]);
  });

  it('refuses a mandate on a route §34 already prints', () => {
    const faults = mandateFaults(
      [
        {
          method: 'GET',
          path: '/api/agents',
          owner: 'W1-CP-05',
          landed: true,
          mandate: { section: '17', because: 'Agents are managed.' },
        },
      ],
      spec,
      sections,
    );
    expect(faults).toEqual([
      'GET /api/agents (W1-CP-05): spec §34 prints this route, so it must not carry a mandate (it ' +
        'cites §17). A mandate here means the two lists have drifted.',
    ]);
  });

  it('names the rule a badly shaped path broke, rather than saying "invalid"', () => {
    // ADR-0026 decision 3's own worked example, both halves: the rename that is admissible under
    // §16, and the RPC spelling that is not.
    expect(routeShape('/api/files/:id/rename', false)).toEqual({ ok: true });
    expect(routeShape('/api/renameFile', false)).toMatchObject({ ok: false, rule: 'shape' });
    expect(routeShape('/api/rename', false)).toMatchObject({ ok: false, rule: 'plural-resource' });
    expect(routeShape('/api/exports', false)).toMatchObject({ ok: false, rule: 'no-verb' });
    expect(routeShape('/api/files/:id/versions/:vid', false)).toMatchObject({
      ok: false,
      rule: 'shape',
    });
    expect(routeShape('/api/files/latest', false)).toMatchObject({ ok: false, rule: 'shape' });
    // Outside /api/ is decided by the specification, not by this shape: §34 prints the public
    // pages under /p/, and nothing else may invent a prefix.
    expect(routeShape('/p/:token', true)).toEqual({ ok: true });
    expect(routeShape('/p/:token', false)).toMatchObject({ ok: false, rule: 'outside-api' });
    expect(routeShape('/internal/metrics', false)).toMatchObject({
      ok: false,
      rule: 'outside-api',
    });
    // Issue #233's named exception, and the proof that it is one literal rather than a relaxed
    // rule: `/api/me` passes, and every other singular resource — including the ones a general
    // "singleton resource" rule would have admitted — still fails `plural-resource`.
    expect(routeShape('/api/me', false)).toEqual({ ok: true });
    // ADR-0135's two A2A literals pass; a neighbouring shape does not.
    expect(routeShape('/api/a2a/agents/:agentName', false)).toEqual({ ok: true });
    expect(routeShape('/api/a2a/agents/:agentName/.well-known/agent-card.json', false)).toEqual({
      ok: true,
    });
    expect(routeShape('/api/a2a/agents/:agentName/tasks', false)).toMatchObject({ ok: false });
    expect(routeShape('/api/a2a/agents', false)).toMatchObject({ ok: false });
    for (const singular of ['/api/session', '/api/config', '/api/whoami', '/api/me/:id/tokens']) {
      expect(routeShape(singular, false), singular).toMatchObject({
        ok: false,
        rule: 'plural-resource',
      });
    }
    // And the shapes §34 actually uses all pass, so the rule is not merely a rejecter.
    for (const admissible of [
      '/api/agents',
      '/api/agents/:id',
      '/api/agents/:id/runs',
      '/api/model-connections',
      '/api/runtime-profiles',
    ]) {
      expect(routeShape(admissible, true), admissible).toEqual({ ok: true });
    }
  });
});
