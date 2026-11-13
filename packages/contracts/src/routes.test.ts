import { describe, expect, it } from 'vitest';

import golden from './__golden__/route-features.json' with { type: 'json' };
import { FEATURE_IDS, ROUTE_FEATURES } from './features.js';
import { API_ROUTE_EXCLUSIONS, API_ROUTES } from './routes.js';
import { CONTRACTS_VERSION_HEADER } from './version.js';

const ENTRIES = [...API_ROUTES, ...API_ROUTE_EXCLUSIONS].map((entry) => ({
  key: `${entry.method} ${entry.path}`,
  feature: entry.feature,
}));
const FEATURE_OF = Object.fromEntries(ENTRIES.map(({ key, feature }) => [key, feature]));

describe('route features (ADR-0160 D4)', () => {
  it('names every catalogued and excluded route once', () => {
    expect(new Set(ENTRIES.map(({ key }) => key)).size).toBe(ENTRIES.length);
  });

  it('gives every route a feature the switch knows, or core', () => {
    const known: readonly string[] = ROUTE_FEATURES;

    expect(ENTRIES.filter(({ feature }) => !known.includes(feature))).toEqual([]);
  });

  it('uses every feature id at least once', () => {
    const used = new Set<string>(ENTRIES.map(({ feature }) => feature));

    expect(FEATURE_IDS.filter((id) => !used.has(id))).toEqual([]);
  });

  it('matches the golden mapping, so a re-tag shows by name in review', () => {
    expect(FEATURE_OF).toEqual(golden);
  });

  it('puts the Agent Builder door on builder, and nothing else', () => {
    expect(
      ENTRIES.filter(({ feature }) => feature === 'builder')
        .map(({ key }) => key)
        .sort(),
    ).toEqual([
      'GET /.well-known/oauth-protected-resource/mcp/builder',
      'POST /api/builder/mcp',
      'POST /mcp/builder',
    ]);
  });
});

describe('route request headers', () => {
  it('declares the optional Idempotency-Key header on runs.start (S-6, #250)', () => {
    const start = API_ROUTES.find((route) => route.operationId === 'runs.start');
    expect(start?.method).toBe('POST');
    expect(start?.path).toBe('/api/agents/:id/runs');
    expect(start?.headers?.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'Idempotency-Key', required: false },
    ]);
  });

  it('names each header once per route, and never one every route already shares', () => {
    const shared = ['authorization', 'cookie', CONTRACTS_VERSION_HEADER.toLowerCase()];
    for (const route of API_ROUTES) {
      const names = (route.headers ?? []).map(({ name }) => name.toLowerCase());
      expect(new Set(names).size, route.operationId).toBe(names.length);
      expect(
        names.filter((name) => shared.includes(name)),
        route.operationId,
      ).toEqual([]);
    }
  });
});
