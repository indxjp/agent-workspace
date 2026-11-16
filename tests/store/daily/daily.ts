/**
 * The daily production test (spec, "The GCP deployment"): the P5 harness runs every live entry's
 * suggested prompt against real Claude in production, and each verdict is sent to the platform with
 * `PUT /api/demo/maintenance/{entry}` so a failing entry's card says "Under maintenance" and its Try
 * tab shows the recording, and a passing one is taken back to "available".
 *
 * An entry the harness could not run at all (no agent in the verification workspace, no run
 * started) gets no verdict: a deployment that is down says nothing about the agent, and the run
 * still fails so a person sees it.
 *
 * Pure of the environment and the file system: `run.ts` is the command line.
 */
import type { LiveEntry } from '../../../examples/store/catalog/define.ts';
import type { DemoMaintenanceRequest } from '@indx-workspace/contracts/demo-operator';

import { operatorCall, type Platform } from './platform.ts';
import {
  verifyLive,
  type LiveClient,
  type LiveRun,
  type VerifyOutcome,
} from '../live-verify/verify.ts';

/** What a record says about its entry: a pass takes it back, a fail puts it under maintenance. */
export function verdictOf(record: LiveRun<'production'>): DemoMaintenanceRequest {
  return record.result === 'pass'
    ? { state: 'available', reason: 'the daily production test passed' }
    : { state: 'maintenance', reason: record.reason };
}

export interface DailyInput {
  readonly client: LiveClient;
  readonly platform: Platform;
  readonly secrets: readonly string[];
  readonly entries: readonly LiveEntry[];
  readonly now: () => Date;
}

export interface DailyOutcome extends VerifyOutcome<'production'> {
  /** The state each entry was set to, and the entries whose verdict the platform did not take. */
  readonly flipped: readonly { readonly entry: string; readonly state: string }[];
  readonly unsent: readonly { readonly entry: string; readonly reason: string }[];
}

export async function runDaily(input: DailyInput): Promise<DailyOutcome> {
  const { client, platform, secrets, entries, now } = input;
  const outcome = await verifyLive({ client, secrets, entries, now, environment: 'production' });
  const flipped: { entry: string; state: string }[] = [];
  const unsent: { entry: string; reason: string }[] = [];
  for (const record of outcome.records) {
    const verdict = verdictOf(record);
    try {
      await operatorCall(platform, 'PUT', `/api/demo/maintenance/${record.entry}`, verdict);
      flipped.push({ entry: record.entry, state: verdict.state });
    } catch (error) {
      unsent.push({
        entry: record.entry,
        reason: error instanceof Error ? error.message : 'failed',
      });
    }
  }
  return { ...outcome, flipped, unsent };
}

/** The process's exit code: 0 only when every entry ran, was judged a pass, and its verdict was kept. */
export function exitCodeOf(outcome: DailyOutcome): number {
  const failed = outcome.records.some((record) => record.result === 'fail');
  return failed || outcome.unrun.length > 0 || outcome.unsent.length > 0 ? 1 : 0;
}
