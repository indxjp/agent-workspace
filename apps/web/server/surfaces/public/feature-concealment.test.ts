/**
 * A hosted surface conceals (ADR-0160 D7) when the workspace that serves it has surfaces off: every
 * entry under `/p/s/<name>` answers what an unknown name answers, never `feature_disabled`.
 */
import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { afterEach, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { clearFeatureSwitches, configureFeatureSwitches } from '../../features/runtime';
import { toResponse } from '../../rbac/http';
import {
  createSurfaceSession,
  preflightSurfaceSession,
  readSurfacePage,
  readTryPage,
  surfacePagePolicy,
} from './handlers';
import { serveWidgetLoader } from '../loader/handler';
import type { WidgetLook } from '../loader/render';
import { resetSurfaceLimits } from './limits';
import type { ResolvedSurface } from './runtime';

const LOCAL_ENV = { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '127.0.0.1' } as const;
const SAME_ORIGIN = new Headers({
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'sec-fetch-site': 'same-origin',
});

const RESOLVED: ResolvedSurface = {
  workspaceId: '33333333-3333-4333-8333-333333333333',
  agentId: '22222222-2222-4222-8222-222222222222',
  agentName: 'Support triage',
  environment: 'local',
  versionId: '55555555-5555-4555-8555-555555555555',
  versionNumber: 2,
  promoted: false,
  surface: { name: 'main', agent: 'Support triage' },
};

const LOOK: WidgetLook = {
  colour: '#0a7f5a',
  foreground: '#ffffff',
  radius: 8,
  layout: 'dock',
  launcherLabel: 'Open Help centre',
  frameTitle: 'Help centre',
};

function install(): { opened: number } {
  const calls = { opened: 0 };
  installTestDomains({
    surfaces: {
      kind: 'serving',
      runtime: {
        resolve: () => Promise.resolve(RESOLVED),
        open: () => {
          calls.opened += 1;
          return Promise.reject(new Error('a concealed surface opens no session'));
        },
        checkModel: () => Promise.resolve(null),
        visitorSurface: () => Promise.reject(new Error('not used')),
        servedSurfaces: () => Promise.resolve([RESOLVED.surface]),
      },
    },
  });
  return calls;
}

function switchSurfaces(on: boolean): void {
  configureFeatureSwitches({
    enabledFor: () =>
      Promise.resolve(on ? FEATURE_IDS : FEATURE_IDS.filter((id) => id !== 'surfaces')),
  });
}

function bootstrap(): Request {
  return new Request('http://127.0.0.1:4310/p/s/main/sessions', {
    method: 'POST',
    headers: SAME_ORIGIN,
  });
}

afterEach(() => {
  clearFeatureSwitches();
  clearApplicationContext();
  resetSurfaceLimits();
});

describe('a hosted surface and a workspace with surfaces switched off', () => {
  it('serves the page while surfaces are on', async () => {
    install();
    switchSurfaces(true);
    expect(await readSurfacePage('main', SAME_ORIGIN, LOCAL_ENV, 'try')).not.toBeNull();
  });

  it('answers the page its unknown-name 404', async () => {
    install();
    switchSurfaces(false);
    expect(await readSurfacePage('main', SAME_ORIGIN, LOCAL_ENV, 'try')).toBeNull();
    expect(await readTryPage('main', SAME_ORIGIN, LOCAL_ENV)).toBeNull();
  });

  it('answers the widget loader its unknown-name 404', async () => {
    install();
    switchSurfaces(false);
    const request = new Request('http://127.0.0.1:4310/p/s/main/widget.js', {
      headers: { host: '127.0.0.1:4310' },
    });
    const response = await serveWidgetLoader(request, 'main', () => LOOK, LOCAL_ENV);
    expect(response.status).toBe(404);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('surface_not_found');
    expect(body).not.toContain('feature_disabled');
  });

  it('answers the session bootstrap surface_not_found and opens nothing', async () => {
    const calls = install();
    switchSurfaces(false);
    const response = toResponse(await createSurfaceSession(bootstrap(), 'main', LOCAL_ENV));
    expect(response.status).toBe(404);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('surface_not_found');
    expect(body).not.toContain('feature_disabled');
    expect(calls.opened).toBe(0);
  });

  it('grants the preflight no CORS headers and frames the page by this origin only', async () => {
    install();
    switchSurfaces(false);
    const headers = await preflightSurfaceSession('main', SAME_ORIGIN, LOCAL_ENV);
    expect(headers).not.toHaveProperty('access-control-allow-origin');
    expect(await surfacePagePolicy('main')).toBe("frame-ancestors 'self'");
  });
});
