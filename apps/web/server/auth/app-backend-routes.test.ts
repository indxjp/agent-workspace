import { describe, expect, it } from 'vitest';

import { APP_BACKEND_ROUTE_SHAPES, isAppBackendRoute } from './app-backend-routes';

const ID = '123e4567-e89b-42d3-a456-426614174000';

describe('the app-backend route list (ADR-0161 D8, D9)', () => {
  it('is exactly the grammar route shapes, read from the catalogue', () => {
    expect([...APP_BACKEND_ROUTE_SHAPES].sort()).toEqual(
      [
        'GET /api/me',
        'GET /api/runs/:id',
        'GET /api/runs/:id/events',
        'POST /api/agents/:id/runs',
        'POST /api/runs/:id/interrupt',
      ].sort(),
    );
  });

  it('admits each shape by its own method only', () => {
    expect(isAppBackendRoute('POST', `/api/agents/${ID}/runs`)).toBe(true);
    expect(isAppBackendRoute('GET', `/api/runs/${ID}`)).toBe(true);
    expect(isAppBackendRoute('GET', `/api/runs/${ID}/events`)).toBe(true);
    expect(isAppBackendRoute('POST', `/api/runs/${ID}/interrupt`)).toBe(true);
    expect(isAppBackendRoute('GET', '/api/me')).toBe(true);
    expect(isAppBackendRoute('GET', `/api/agents/${ID}/runs`)).toBe(false);
    expect(isAppBackendRoute('DELETE', `/api/runs/${ID}`)).toBe(false);
    expect(isAppBackendRoute('POST', `/api/runs/${ID}`)).toBe(false);
  });

  it('admits nothing else: the run list, feedback, files, workspaces or a longer path', () => {
    for (const [method, path] of [
      ['GET', '/api/runs'],
      ['POST', `/api/runs/${ID}/feedback`],
      ['POST', `/api/runs/${ID}/approval`],
      ['POST', '/api/files'],
      ['GET', '/api/workspaces'],
      ['GET', '/api/me/extra'],
      ['POST', `/api/agents/${ID}/runs/extra`],
      ['POST', `/api/agents/${ID}/messages`],
    ] as const) {
      expect(isAppBackendRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
