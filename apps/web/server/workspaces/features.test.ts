/**
 * The workspace feature-switch use case (ADR-0160 D6–D8), against an in-memory repository and a
 * captured audit sink: what each refusal answers, and that an audit row is written once per
 * effective change and never for a refusal or a repeat.
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import { describe, expect, it } from 'vitest';

import type { ApiProblem } from '../http/result';
import { listWorkspaceFeatures, updateWorkspaceFeatures } from './features';
import type { WorkspaceFeaturesAuditEvent } from './features-runtime';

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const ACTOR = { principalId: 'principal-1', userId: 'user-1', label: 'owner@example.com' };

function harness(initiallyDisabled: readonly FeatureId[] = []) {
  let disabled: readonly FeatureId[] = FEATURE_IDS.filter((id) => initiallyDisabled.includes(id));
  const writes: (readonly FeatureId[])[] = [];
  const audit: WorkspaceFeaturesAuditEvent[] = [];
  let provisioned = 0;
  return {
    writes,
    audit,
    provisioned: () => provisioned,
    provisionBuilder: () => {
      provisioned += 1;
      return Promise.resolve();
    },
    repository: {
      listDisabled: () => Promise.reject(new Error('the use case reads `before` from the replace')),
      replaceDisabled: (next: readonly FeatureId[]) => {
        writes.push(next);
        const before = disabled;
        disabled = FEATURE_IDS.filter((id) => next.includes(id));
        return Promise.resolve({ before, after: disabled });
      },
    },
    recordAudit: (event: WorkspaceFeaturesAuditEvent) => {
      audit.push(event);
      return Promise.resolve();
    },
  };
}

function update(
  h: ReturnType<typeof harness>,
  body: unknown,
  deployment: readonly FeatureId[] = FEATURE_IDS,
) {
  return updateWorkspaceFeatures({
    deployment,
    repository: h.repository,
    recordAudit: h.recordAudit,
    provisionBuilder: h.provisionBuilder,
    workspaceId: WORKSPACE_ID,
    actor: ACTOR,
    body,
  });
}

function errorOf(result: { body: unknown }): ApiProblem['error'] {
  return (result.body as ApiProblem).error;
}

describe('listWorkspaceFeatures', () => {
  it('answers one row per feature in FEATURE_IDS order', () => {
    const { features } = listWorkspaceFeatures(FEATURE_IDS, []);
    expect(features.map((row) => row.id)).toEqual([...FEATURE_IDS]);
    expect(features.every((row) => row.installed && row.enabled)).toBe(true);
  });

  it('marks a switched-off feature not enabled and an uninstalled one neither installed nor enabled', () => {
    const deployment = FEATURE_IDS.filter((id) => id !== 'files');
    const rows = Object.fromEntries(
      listWorkspaceFeatures(deployment, ['chat']).features.map((row) => [row.id, row]),
    );
    expect(rows['chat']).toEqual({ id: 'chat', installed: true, enabled: false });
    expect(rows['files']).toEqual({ id: 'files', installed: false, enabled: false });
    expect(rows['runs']).toEqual({ id: 'runs', installed: true, enabled: true });
  });
});

describe('updateWorkspaceFeatures refusals', () => {
  it.each([
    ['an unknown id', { disabled: ['nope'] }],
    ['a duplicate id', { disabled: ['files', 'files'] }],
    ['an extra key', { disabled: [], enabled: [] }],
    ['a missing key', {}],
    ['a non-object', 'files'],
    ['null', null],
  ])('answers 400 invalid_body for %s, and writes nothing', async (_name, body) => {
    const h = harness();
    const result = await update(h, body);
    expect(result.status).toBe(400);
    expect(errorOf(result).code).toBe('invalid_body');
    expect(h.writes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('answers 409 feature_not_installed naming the id when the body would switch on a feature the deployment lacks', async () => {
    const h = harness();
    const deployment = FEATURE_IDS.filter((id) => id !== 'files');
    const result = await update(h, { disabled: [] }, deployment);
    expect(result.status).toBe(409);
    expect(errorOf(result).code).toBe('feature_not_installed');
    expect(errorOf(result).details).toEqual(['files']);
    expect(h.writes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('accepts a body that lists the uninstalled feature as off', async () => {
    const h = harness();
    const deployment = FEATURE_IDS.filter((id) => id !== 'files');
    const result = await update(h, { disabled: ['files'] }, deployment);
    expect(result.status).toBe(200);
  });

  it('answers 409 feature_in_use naming the dependent when chat goes off while surfaces is on', async () => {
    const h = harness();
    const result = await update(h, { disabled: ['chat'] });
    expect(result.status).toBe(409);
    expect(errorOf(result).code).toBe('feature_in_use');
    expect(errorOf(result).details).toEqual(['feature:surfaces']);
    expect(h.writes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('names every dependent, sorted, when runs goes off', async () => {
    const result = await update(harness(), { disabled: ['runs'] });
    expect(result.status).toBe(409);
    expect(errorOf(result).details).toEqual(['feature:evaluations', 'feature:triggers']);
  });

  it('allows a feature off together with its dependents', async () => {
    const result = await update(harness(), { disabled: ['chat', 'surfaces'] });
    expect(result.status).toBe(200);
  });
});

describe('updateWorkspaceFeatures success', () => {
  it('replaces the off set, answers the new rows and writes exactly one audit row', async () => {
    const h = harness();
    const result = await update(h, { disabled: ['files', 'skills'] });
    expect(result.status).toBe(200);
    expect(h.writes).toEqual([['files', 'skills']]);
    expect(result.body).toEqual(listWorkspaceFeatures(FEATURE_IDS, ['skills', 'files']));
    expect(h.audit).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        actorPrincipalId: ACTOR.principalId,
        actorUserId: ACTOR.userId,
        actorLabel: ACTOR.label,
        action: 'workspace-features-changed',
        subjectId: null,
        subjectLabel: 'Features off: files, skills',
      },
    ]);
  });

  it('labels switching everything back on', async () => {
    const h = harness(['files']);
    const result = await update(h, { disabled: [] });
    expect(result.status).toBe(200);
    expect(h.audit.map((event) => event.subjectLabel)).toEqual(['Features: all on']);
  });

  it('writes no audit row when the set did not change, and still answers 200', async () => {
    const h = harness(['files']);
    const result = await update(h, { disabled: ['files'] });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(listWorkspaceFeatures(FEATURE_IDS, ['files']));
    expect(h.audit).toEqual([]);
  });

  it('audits by the `before` the replace itself read, not by an earlier separate read', async () => {
    // Another PUT committed `files` between this request's start and its replace: the replace's own
    // `before` is `files`, so this request changed nothing and must not audit.
    const h = harness();
    const raced = {
      ...h.repository,
      replaceDisabled: (next: readonly FeatureId[]) =>
        Promise.resolve({
          before: ['files'] as readonly FeatureId[],
          after: FEATURE_IDS.filter((id) => next.includes(id)),
        }),
    };
    const result = await updateWorkspaceFeatures({
      deployment: FEATURE_IDS,
      repository: raced,
      recordAudit: h.recordAudit,
      provisionBuilder: h.provisionBuilder,
      workspaceId: WORKSPACE_ID,
      actor: ACTOR,
      body: { disabled: ['files'] },
    });
    expect(result.status).toBe(200);
    expect(h.audit).toEqual([]);
  });

  it('ensures the Builder once when a write switches builder on, and not for any other write', async () => {
    const h = harness(['builder']);
    await update(h, { disabled: ['builder'] });
    expect(h.provisioned()).toBe(0);
    await update(h, { disabled: [] });
    expect(h.provisioned()).toBe(1);
    await update(h, { disabled: [] });
    await update(h, { disabled: ['files'] });
    await update(h, { disabled: ['files', 'builder'] });
    expect(h.provisioned()).toBe(1);
  });

  it('writes one audit row for a first change and none for the repeat', async () => {
    const h = harness();
    await update(h, { disabled: ['files'] });
    await update(h, { disabled: ['files'] });
    expect(h.audit).toHaveLength(1);
  });
});
