/**
 * The decisions of {@link createSurfaceSessionsRuntime}'s `open` (issue #538, C18, SD8), over
 * in-memory fakes of each dependency: which agent a bootstrap may talk to, which session a key
 * resumes, and that every refusal writes nothing. `surface-sessions.integration.test.ts` proves
 * the same against PostgreSQL through `register()`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { type SurfaceSessionRequest } from '@indx-workspace/contracts/surfaces';
import { counterIds } from '../../ids';
import { hashApiKeySecret } from '../../rbac/api-key';
import {
  EXPIRES_AT,
  type Fixture,
  fixture,
  type Opened,
  openedBy,
  OWNER,
  resumeOf,
  STRANGER,
  TOKEN,
} from './composition.test-support';

describe('createSurfaceSessionsRuntime().open (issue #538)', () => {
  let state: Fixture;
  beforeEach(async () => {
    state = await fixture();
  });

  it('opens a session of the surface agent and records only the digest of its resume key', async () => {
    const opened = await openedBy(state, {});
    expect(opened.agentId).toBe(state.agents.desk.id);
    expect(opened.resumeKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const row = state.keys.get(opened.sessionId);
    expect(row).toEqual({
      sessionId: opened.sessionId,
      surfaceName: 'main',
      agentId: state.agents.desk.id,
      keyHash: await hashApiKeySecret(resumeOf(opened).resumeKey),
    });
    expect(row?.keyHash).not.toBe(opened.resumeKey);
    // Issue #612: the conversation pins the version `local` points at when it starts.
    expect(state.sessions.get(opened.sessionId)?.agentVersionId).toBe(
      `local-version-of-${state.agents.desk.id}`,
    );
  });

  it('names each new session with the id generator it is given', async () => {
    state = await fixture({ ids: counterIds() });
    const first = await openedBy(state, {});
    const second = await openedBy(state, {});
    expect([first.sessionId, second.sessionId]).toStrictEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(state.sessions.get(first.sessionId)?.agentId).toBe(state.agents.desk.id);
  });

  it('opens an offered agent of the same owner as that owner, after its own preflight', async () => {
    const opened = await openedBy(state, { agent: 'Billing' });
    expect(opened.agentId).toBe(state.agents.billing.id);
    expect(state.preflights).toEqual([
      {
        owner: OWNER,
        agentId: state.agents.billing.id,
        sessionId: null,
        versionId: `local-version-of-${state.agents.billing.id}`,
      },
    ]);
    expect(state.sessions.get(opened.sessionId)?.agentId).toBe(state.agents.billing.id);
  });

  it.each([
    ['not listed', 'Somebody else'],
    ['listed but owned by another principal', 'Foreign'],
    ['listed but with no local pointer', 'Unpointed'],
  ])('refuses an agent %s with agent-not-offered, writing nothing', async (_label, agent) => {
    await expect(state.runtime.open(state.resolved, { agent })).resolves.toEqual({
      kind: 'agent-not-offered',
    });
    expect(state.preflights).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it('pins and preflights the version the surface resolved to (#612)', async () => {
    state.promoted.add(state.agents.desk.id);
    const production = `production-version-of-${state.agents.desk.id}`;
    const opened = await state.runtime.open(
      { ...state.resolved, environment: 'production', versionId: production, promoted: true },
      {},
    );
    if (opened.kind !== 'opened') throw new Error(`expected a session, got ${opened.kind}`);
    expect(state.sessions.get(opened.sessionId)?.agentVersionId).toBe(production);
    expect(state.preflights.at(-1)).toMatchObject({ sessionId: null, versionId: production });

    // The try page's session pins the local working draft it was resolved to.
    const tried = await openedBy(state, { environment: 'local' });
    expect(state.sessions.get(tried.sessionId)?.agentVersionId).toBe(
      `local-version-of-${state.agents.desk.id}`,
    );
  });

  it('pins the resolved version even when a promote lands before the session opens (#622)', async () => {
    // Resolved while `local` served the public; promoted before `open`: no second pick.
    state.promoted.add(state.agents.desk.id);
    const opened = await openedBy(state, {});
    expect(state.sessions.get(opened.sessionId)?.agentVersionId).toBe(state.resolved.versionId);
  });

  it('picks each offered agent’s environment by the same rule (#612)', async () => {
    state.promoted.add(state.agents.desk.id);
    const billing = await openedBy(state, { agent: 'Billing' });
    expect(state.sessions.get(billing.sessionId)?.agentVersionId).toBe(
      `local-version-of-${state.agents.billing.id}`,
    );
    state.promoted.add(state.agents.billing.id);
    const promoted = await openedBy(state, { agent: 'Billing' });
    expect(state.sessions.get(promoted.sessionId)?.agentVersionId).toBe(
      `production-version-of-${state.agents.billing.id}`,
    );
  });

  it('refuses an agent that is in the workspace but not offered', async () => {
    const resolved = { ...state.resolved, surface: { name: 'main', agent: 'Front desk' } };
    await expect(state.runtime.open(resolved, { agent: 'Billing' })).resolves.toEqual({
      kind: 'agent-not-offered',
    });
  });

  it('resumes the same session with a fresh token, no new key and nothing written', async () => {
    const first = await openedBy(state, {});
    state.writes.length = 0;
    const resumed = await openedBy(state, { resume: resumeOf(first) });
    expect(resumed).toEqual({
      kind: 'opened',
      sessionId: first.sessionId,
      agentId: state.agents.desk.id,
      token: TOKEN,
      expiresAt: EXPIRES_AT,
      resumeKey: null,
    });
    expect(state.writes).toEqual([]);
    expect(state.preflights.at(-1)?.sessionId).toBe(first.sessionId);
  });

  it('switches A → B → A and resumes A with A key; B key never resumes A', async () => {
    const deskSession = await openedBy(state, {});
    const billingSession = await openedBy(state, { agent: 'Billing' });
    const back = await openedBy(state, { resume: resumeOf(deskSession) });
    expect(back.sessionId).toBe(deskSession.sessionId);
    expect(back.agentId).toBe(state.agents.desk.id);

    const crossed = {
      sessionId: deskSession.sessionId,
      resumeKey: resumeOf(billingSession).resumeKey,
    };
    await expect(state.runtime.open(state.resolved, { resume: crossed })).resolves.toEqual({
      kind: 'not-resumable',
    });
    // B's own key, presented as the surface agent rather than B, resumes nothing either.
    await expect(
      state.runtime.open(state.resolved, { resume: resumeOf(billingSession) }),
    ).resolves.toEqual({ kind: 'not-resumable' });
    await expect(
      openedBy(state, { agent: 'Billing', resume: resumeOf(billingSession) }),
    ).resolves.toMatchObject({ sessionId: billingSession.sessionId });
  });

  it.each<[string, (state: Fixture, opened: Opened) => SurfaceSessionRequest]>([
    [
      'a wrong key',
      (_s, opened) => ({ resume: { ...resumeOf(opened), resumeKey: 'x'.repeat(43) } }),
    ],
    [
      'an unknown session',
      (_s, opened) => ({ resume: { ...resumeOf(opened), sessionId: crypto.randomUUID() } }),
    ],
    [
      'another surface key',
      (s, opened) => {
        const row = s.keys.get(opened.sessionId);
        if (row !== undefined) s.keys.set(opened.sessionId, { ...row, surfaceName: 'other' });
        return { resume: resumeOf(opened) };
      },
    ],
    [
      'an archived session',
      (s, opened) => {
        const session = s.sessions.get(opened.sessionId);
        if (session !== undefined)
          s.sessions.set(opened.sessionId, { ...session, status: 'archived' });
        return { resume: resumeOf(opened) };
      },
    ],
    [
      'a session whose owner changed',
      (s, opened) => {
        const session = s.sessions.get(opened.sessionId);
        if (session !== undefined) {
          s.sessions.set(opened.sessionId, { ...session, ownerPrincipalId: STRANGER });
        }
        return { resume: resumeOf(opened) };
      },
    ],
  ])(
    'refuses %s with not-resumable, before preflight and writing nothing',
    async (_label, build) => {
      const opened = await openedBy(state, {});
      const request = build(state, opened);
      state.writes.length = 0;
      state.preflights.length = 0;
      await expect(state.runtime.open(state.resolved, request)).resolves.toEqual({
        kind: 'not-resumable',
      });
      expect(state.preflights).toEqual([]);
      expect(state.writes).toEqual([]);
    },
  );

  it('refuses a resume whose session is archived after the resume check with not-resumable (#602 review)', async () => {
    const opened = await openedBy(state, {});
    // The preflight runs between `isResumable` and `tokens.issue`; archiving there is the race.
    state.archiveOnPreflight = opened.sessionId;
    await expect(state.runtime.open(state.resolved, { resume: resumeOf(opened) })).resolves.toEqual(
      { kind: 'not-resumable' },
    );
  });

  it('refuses a resume the preflight refuses, writing nothing', async () => {
    const opened = await openedBy(state, {});
    state.writes.length = 0;
    state.refusePreflight = true;
    await expect(state.runtime.open(state.resolved, { resume: resumeOf(opened) })).resolves.toEqual(
      {
        kind: 'refused',
        code: 'agent_runtime_profile_missing',
        message: 'no runtime profile',
      },
    );
    expect(state.writes).toEqual([]);
  });
});

describe('createSurfaceSessionsRuntime() and an archived agent (issue #1851)', () => {
  const REFUSED = {
    kind: 'refused',
    code: 'agent_archived',
    message: expect.stringContaining('archived') as unknown,
  };

  it('refuses a bootstrap of an archived agent before any session exists', async () => {
    const state = await fixture();
    state.archived.add(state.agents.desk.id);

    await expect(state.runtime.open(state.resolved, {})).resolves.toEqual(REFUSED);
    expect(state.writes).toEqual([]);
    expect(state.sessions.size).toBe(0);
    expect(state.keys.size).toBe(0);
  });

  it('refuses an archived agent offered by the switcher, and opens an active one', async () => {
    const state = await fixture();
    state.archived.add(state.agents.billing.id);

    await expect(state.runtime.open(state.resolved, { agent: 'Billing' })).resolves.toEqual(
      REFUSED,
    );
    expect(state.writes).toEqual([]);
    await expect(state.runtime.open(state.resolved, {})).resolves.toMatchObject({
      kind: 'opened',
    });
  });

  it('names the archive in checkModel too', async () => {
    const state = await fixture();
    state.archived.add(state.agents.desk.id);

    await expect(state.runtime.checkModel(state.resolved)).resolves.toMatchObject({
      code: 'agent_archived',
    });
  });
});
