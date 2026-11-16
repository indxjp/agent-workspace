/**
 * The in-memory trigger repository the trigger route tests run against: its delivery claim is atomic
 * like the unique index it stands for, and its updates restart a schedule as PostgreSQL does.
 */
import { randomUUID } from 'node:crypto';

import { TEST_WORKSPACE_ID } from '../rbac/testing';
import type { TriggerRecord, TriggersRuntime } from './runtime';
import type { TriggerTestState } from './triggers.runtime.test-support';

type TriggerRepository = Awaited<ReturnType<TriggersRuntime['repository']>>;
type TriggerCreateInput = Parameters<TriggerRepository['create']>[0];
type TriggerPatch = Parameters<TriggerRepository['update']>[1];

function deliveryRepository(
  state: TriggerTestState,
): Pick<
  TriggerRepository,
  'claimDelivery' | 'recordDeliveryRun' | 'releaseDelivery' | 'pruneDeliveries'
> {
  return {
    claimDelivery: (_triggerId, key) => {
      if (state.deliveries.has(key)) {
        return Promise.resolve({ kind: 'duplicate', runId: state.deliveries.get(key) ?? null });
      }
      state.deliveries.set(key, null);
      return Promise.resolve({ kind: 'claimed' });
    },
    recordDeliveryRun: (_triggerId, key, runId) => {
      if (state.failRecordRun) return Promise.reject(new Error('database unavailable'));
      state.deliveries.set(key, runId);
      return Promise.resolve(true);
    },
    releaseDelivery: (_triggerId, key) =>
      state.failRelease
        ? Promise.reject(new Error('release unavailable'))
        : Promise.resolve(state.deliveries.delete(key)),
    pruneDeliveries: () => Promise.resolve(0),
  };
}

function triggerNameExists(state: TriggerTestState, name: string, except: string | null): boolean {
  return [...state.rows.values()].some((row) => row.name === name && row.id !== except);
}

/** The row the repository would insert for `input`; pure apart from the generated id. */
function newTriggerRow(input: TriggerCreateInput, now: Date): TriggerRecord {
  return {
    id: randomUUID(),
    workspaceId: TEST_WORKSPACE_ID,
    agentId: input.agentId,
    name: input.name,
    kind: input.kind,
    promptTemplate: input.promptTemplate,
    cron: input.kind === 'schedule' ? input.cron : null,
    timezone: input.kind === 'schedule' ? input.timezone : null,
    enabled: input.enabled ?? true,
    outputSchema: input.outputSchema ?? null,
    subject: input.subject ?? null,
    ownerPrincipalId: input.ownerPrincipalId,
    hasSecret: input.kind === 'webhook',
    lastFiredAt: null,
    scheduleFrom: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createTrigger(
  state: TriggerTestState,
  input: TriggerCreateInput,
): ReturnType<TriggerRepository['create']> {
  if (!state.agentOwners.has(input.agentId)) return Promise.resolve({ kind: 'agent-not-found' });
  if (triggerNameExists(state, input.name, null)) return Promise.resolve({ kind: 'name-taken' });
  const row = newTriggerRow(input, new Date());
  state.rows.set(row.id, row);
  if (input.kind === 'webhook') state.hashes.set(row.id, input.secretHash);
  return Promise.resolve({ kind: 'created', trigger: row });
}

/**
 * As the PostgreSQL repository does (ADR-0144 D5): enabling, or a new cron or time zone, restarts
 * the schedule's counting now.
 */
function restartsSchedule(row: TriggerRecord, patch: TriggerPatch): boolean {
  return (
    (patch.enabled === true && !row.enabled) ||
    (patch.cron !== undefined && patch.cron !== row.cron) ||
    (patch.timezone !== undefined && patch.timezone !== row.timezone)
  );
}

/** `row` with `patch` applied; pure. */
function patchedRow(row: TriggerRecord, patch: TriggerPatch, now: Date): TriggerRecord {
  return {
    ...row,
    name: patch.name ?? row.name,
    promptTemplate: patch.promptTemplate ?? row.promptTemplate,
    cron: patch.cron ?? row.cron,
    timezone: patch.timezone ?? row.timezone,
    enabled: patch.enabled ?? row.enabled,
    outputSchema: patch.outputSchema === undefined ? row.outputSchema : patch.outputSchema,
    subject: patch.subject === undefined ? row.subject : patch.subject,
    scheduleFrom: restartsSchedule(row, patch) ? now : row.scheduleFrom,
  };
}

function updateTrigger(
  state: TriggerTestState,
  id: string,
  patch: TriggerPatch,
): ReturnType<TriggerRepository['update']> {
  const row = state.rows.get(id);
  if (row === undefined) return Promise.resolve({ kind: 'not-found' });
  if (patch.name !== undefined && triggerNameExists(state, patch.name, id)) {
    return Promise.resolve({ kind: 'name-taken' });
  }
  if ((patch.cron !== undefined || patch.timezone !== undefined) && row.kind !== 'schedule') {
    return Promise.resolve({ kind: 'invalid-shape' });
  }
  const next = patchedRow(row, patch, new Date());
  state.rows.set(id, next);
  return Promise.resolve({ kind: 'updated', trigger: next });
}

export function triggerRepository(state: TriggerTestState): TriggerRepository {
  return {
    list: () => Promise.resolve([...state.rows.values()]),
    get: (id) => Promise.resolve(state.rows.get(id) ?? null),
    create: (input) => createTrigger(state, input),
    update: (id, patch) => updateTrigger(state, id, patch),
    setSecretHash: (id, secretHash) => {
      const row = state.rows.get(id);
      if (row === undefined) return Promise.resolve({ kind: 'not-found' });
      state.hashes.set(id, secretHash);
      return Promise.resolve({ kind: 'set', trigger: row });
    },
    countDeliveriesSince: () => Promise.resolve(state.recentDeliveries ?? state.deliveries.size),
    countUnfinishedRuns: () => Promise.resolve(state.unfinishedRuns),
    markFired: (id, at) => {
      const row = state.rows.get(id);
      if (row === undefined) return Promise.resolve(false);
      state.rows.set(id, { ...row, lastFiredAt: at });
      return Promise.resolve(true);
    },
    remove: (id) => Promise.resolve(state.rows.delete(id)),
    ...deliveryRepository(state),
  };
}
