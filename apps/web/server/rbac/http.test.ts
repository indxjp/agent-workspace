/**
 * The order `authorise()` answers in once ADR-0160 D7 adds a feature gate: identify first (no
 * credential is still a `401`, never `feature_disabled`), then the gate, and only then the ownership
 * read and `decide()`.
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearFeatureSwitches, configureFeatureSwitches } from '../features/runtime';
import { authorise, toResponse, type AuthorisedRequest } from './http';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from './testing';

const OWNER = { email: 'owner@example.test' };

function harness(): RbacHarness {
  return installRbacHarness([
    { email: OWNER.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
  ]);
}

function switchOff(...off: readonly FeatureId[]): void {
  configureFeatureSwitches({
    enabledFor: () => Promise.resolve(FEATURE_IDS.filter((id) => !off.includes(id))),
  });
}

describe('authorise() and the feature gate (ADR-0160 D7)', () => {
  let rig: RbacHarness | null = null;
  afterEach(() => {
    clearFeatureSwitches();
    rig?.teardown();
    rig = null;
  });

  function get(path: string, as: typeof OWNER | null, run: (c: AuthorisedRequest) => void) {
    rig = rig ?? harness();
    const ownership = vi.fn(() => ({ kind: 'ownership', ownership: 'not-applicable' }) as const);
    const call = rig.call(
      async (request) =>
        toResponse(
          await authorise(request, ownership, (context) => {
            run(context);
            return Promise.resolve({ status: 200, body: { ok: true } });
          }),
        ),
      { method: 'GET', path, as },
    );
    return { call, ownership };
  }

  it('answers 401, not feature_disabled, when nothing identifies the caller', async () => {
    switchOff(...FEATURE_IDS);
    const run = vi.fn();
    const { call, ownership } = get('/api/files', null, run);
    expect((await call).status).toBe(401);
    expect(ownership).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 404 feature_disabled to an Owner and never reads the ownership row', async () => {
    switchOff('files');
    const run = vi.fn();
    const { call, ownership } = get('/api/files', OWNER, run);
    const answer = await call;
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ error: { code: 'feature_disabled', details: ['files'] } });
    expect(ownership).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('hands the handler the enabled set when the feature is on', async () => {
    let seen: readonly FeatureId[] = [];
    const { call, ownership } = get('/api/files', OWNER, ({ features }) => {
      seen = features;
    });
    expect((await call).status).toBe(200);
    expect(seen).toEqual(FEATURE_IDS);
    expect(ownership).toHaveBeenCalledOnce();
  });

  it('still serves a core route with every feature switched off', async () => {
    switchOff(...FEATURE_IDS);
    const run = vi.fn();
    const { call } = get('/api/agents', OWNER, run);
    expect((await call).status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });
});
