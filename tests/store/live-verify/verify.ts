/**
 * The real-model harness (R1; spec, "Real-model verification gate (R1)"): one run of each live
 * entry's suggested prompt against real Claude through the store's staging deployment, judged with
 * the same rule as the recordings (`judgeMoment` over a turn `recordTurn` builds), written as
 * evidence records for `examples/store/catalog/real-model-runs.json`.
 *
 * This file is the core and does no I/O of its own beyond the SDK client it is handed (no file, no
 * environment), so the tests drive it against the scripted model. `run.ts` is the command line and
 * `evidence-file.ts` reads and writes the committed file. Nothing here
 * runs in `pnpm test` against a real URL: the only way to spend is `run.ts` with the opt-in.
 *
 * The credential is one workspace API key (never printed: {@link redact} cleans every message that
 * leaves this module). Least privilege: a key with the `builder` role (it can start runs and decide
 * their approvals, and nothing else of an owner's) in a dedicated verification workspace of the
 * staging project that holds a copy of each live entry's agent under the entry's `demo.agent` name,
 * as a visitor's demo workspace does, and nothing else: no connector secret, no member, no real data.
 */
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import type { RunEventFrame } from '@indx-workspace/sdk/events';

import type { LiveEntry } from '../../../examples/store/catalog/define.ts';
import { judgeMoment } from '../../../examples/store/catalog/recording.ts';
import {
  realModelEvidenceSchema,
  type RealModelEvidence,
  type RealModelRun,
} from '../../../examples/store/catalog/verification.ts';
import { recordTurn, type RecordedRun } from '../proof/record-turn.ts';

/** The opt-in value of `STORE_LIVE_VERIFY`: a person has approved the spend. */
export const SPEND_APPROVED = 'spend-approved';

/** How many approval waits one turn is followed through before it is judged as it stands. */
export const MAX_APPROVALS = 3;

/** The longest a failed record's reason may be (the evidence schema's limit). */
export const REASON_MAX = 500;

export interface LiveVerifyEnv {
  readonly STORE_LIVE_VERIFY?: string | undefined;
  /** `staging` (R1) or `production` (the daily production test); nowhere else. */
  readonly STORE_LIVE_VERIFY_ENVIRONMENT?: string | undefined;
  /** The deployment's control plane origin. */
  readonly STORE_LIVE_VERIFY_URL?: string | undefined;
  /** The verification workspace's API key. */
  readonly STORE_LIVE_VERIFY_API_KEY?: string | undefined;
}

/** Where a run is made: R1 in staging, the daily production test in production. */
export type LiveEnvironment = 'staging' | 'production';

export interface Settings {
  readonly environment: LiveEnvironment;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** Thrown when the harness must not run or cannot run; its message never holds a secret. */
export class LiveVerifyRefusal extends Error {}

/** `text` with every secret removed, however it got there. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret !== '')
    .reduce((clean, secret) => clean.split(secret).join('[redacted]'), text);
}

/**
 * Every value from `env` a message must never carry: the API key, the deployment URL and its host.
 * The workflow keeps the staging origin as a secret too, and a transport error can name either.
 */
export function secretsOf(env: LiveVerifyEnv): readonly string[] {
  const url = env.STORE_LIVE_VERIFY_URL?.trim() ?? '';
  const apiKey = env.STORE_LIVE_VERIFY_API_KEY?.trim() ?? '';
  const host = URL.canParse(url) ? new URL(url).host : '';
  return [apiKey, url, host].filter((secret) => secret !== '');
}

/** The settings `env` gives, or a refusal that says what is missing without echoing any value. */
export function readSettings(env: LiveVerifyEnv): Settings {
  if (env.STORE_LIVE_VERIFY !== SPEND_APPROVED) {
    throw new LiveVerifyRefusal(
      `refused: this run spends on a real model; set STORE_LIVE_VERIFY=${SPEND_APPROVED} once a person has approved the spend`,
    );
  }
  const environment = env.STORE_LIVE_VERIFY_ENVIRONMENT;
  if (environment !== 'staging' && environment !== 'production') {
    throw new LiveVerifyRefusal(
      'refused: STORE_LIVE_VERIFY_ENVIRONMENT must be staging or production',
    );
  }
  const baseUrl = env.STORE_LIVE_VERIFY_URL?.trim() ?? '';
  const apiKey = env.STORE_LIVE_VERIFY_API_KEY?.trim() ?? '';
  if (baseUrl === '' || apiKey === '') {
    throw new LiveVerifyRefusal(
      'refused: STORE_LIVE_VERIFY_URL and STORE_LIVE_VERIFY_API_KEY are both required',
    );
  }
  return { environment, baseUrl, apiKey };
}

/** The part of the SDK client the harness uses, so a test can hand it the scripted workspace's. */
export interface LiveClient {
  readonly agents: Pick<AgentWorkspaceClient['agents'], 'list'>;
  readonly runs: Pick<AgentWorkspaceClient['runs'], 'start' | 'follow' | 'get' | 'approve'>;
}

/** The SDK client for `settings`: the API key is the only credential, sent as a bearer. */
export function clientFor(settings: Settings): LiveClient {
  return createClient({
    baseUrl: settings.baseUrl,
    auth: { kind: 'api-key', apiKey: settings.apiKey },
  });
}

/** One run's record: the committed evidence's record in staging, the same fields in production. */
export type LiveRun<E extends LiveEnvironment> = Omit<RealModelRun, 'environment'> & {
  readonly environment: E;
};

export interface VerifyInput<E extends LiveEnvironment> {
  readonly client: LiveClient;
  /** Every string a message must never carry; the API key at least. */
  readonly secrets: readonly string[];
  readonly entries: readonly LiveEntry[];
  /** The clock the records' dates come from. */
  readonly now: () => Date;
  /** Where the run is made: staging for the live-verify command, production for the daily test. */
  readonly environment: E;
}

export interface VerifyOutcome<E extends LiveEnvironment = 'staging'> {
  readonly records: readonly LiveRun<E>[];
  /** Entries that could not be run at all (no agent, no run started): no record, never a fail. */
  readonly unrun: readonly { readonly entry: string; readonly reason: string }[];
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, REASON_MAX);
}

/**
 * Runs each entry's first suggested prompt once and judges it. A moment that did not happen is a
 * `fail` record with the judge's reason; a run the platform never started is `unrun`, because a
 * record needs the run's id and a deployment that is down says nothing about the agent.
 */
export async function verifyLive<E extends LiveEnvironment>(
  input: VerifyInput<E>,
): Promise<VerifyOutcome<E>> {
  const { client, secrets, entries, now, environment } = input;
  const records: LiveRun<E>[] = [];
  const unrun: { entry: string; reason: string }[] = [];
  let agents: readonly { readonly id: string; readonly name: string }[];
  try {
    agents = await client.agents.list();
  } catch (error) {
    throw new LiveVerifyRefusal(
      `the deployment's agents could not be listed: ${oneLine(redact(describe(error), secrets))}`,
    );
  }
  for (const entry of entries) {
    const check = entry.demo.check;
    const agent = agents.find((candidate) => candidate.name === entry.demo.agent);
    if (check === undefined || agent === undefined) {
      unrun.push({
        entry: entry.slug,
        reason:
          check === undefined
            ? 'the entry states no moment to check'
            : 'no agent with the demo name',
      });
      continue;
    }
    const prompt = entry.demo.prompts[0]?.en ?? '';
    const date = now().toISOString();
    let runId: string | null = null;
    try {
      const started = await client.runs.start(agent.id, { prompt });
      runId = started.run.id;
      const runs: RecordedRun[] = [];
      let current = runId;
      for (let approvals = 0; ; approvals += 1) {
        const frames: RunEventFrame[] = [];
        for await (const frame of client.runs.follow(current)) frames.push(frame);
        const run = await client.runs.get(current);
        if (run.status !== 'awaiting_approval' || approvals === MAX_APPROVALS) {
          runs.push({ frames });
          break;
        }
        // The person who asked approves: the verifier is that person for its own run.
        const answer = await client.runs.approve(current, {});
        runs.push({ frames, decision: 'approved' });
        current = answer.run.id;
      }
      const verdict = judgeMoment(recordTurn(prompt, runs), check);
      records.push({
        entry: entry.slug,
        runId,
        date,
        result: verdict.pass ? 'pass' : 'fail',
        reason: verdict.pass ? 'the moment happened' : oneLine(redact(verdict.reason, secrets)),
        environment,
      });
    } catch (error) {
      const reason = oneLine(redact(describe(error), secrets));
      if (runId === null) unrun.push({ entry: entry.slug, reason });
      else {
        records.push({
          entry: entry.slug,
          runId,
          date,
          result: 'fail',
          reason: reason === '' ? 'the run could not be followed' : reason,
          environment,
        });
      }
    }
  }
  return { records, unrun };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** The evidence with `records` after its earlier records, which are never rewritten. */
export function appendEvidence(
  existing: RealModelEvidence,
  records: readonly RealModelRun[],
): RealModelEvidence {
  return realModelEvidenceSchema.parse({ runs: [...existing.runs, ...records] });
}
