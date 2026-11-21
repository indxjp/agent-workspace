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
 * staging project that holds a copy of each seeded entry's agent under the entry's `demo.agent` name,
 * as a visitor's demo workspace does, and nothing else: no connector secret, no member, no real data.
 */
import type { AgentResource } from '@indx-workspace/contracts/agents';
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import type { RunEventFrame } from '@indx-workspace/sdk/events';

import type { SourcedEntry } from '../../../examples/store/catalog/define.ts';
import { judgeMoment, type RecordedTurn } from '../../../examples/store/catalog/recording.ts';
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
  /**
   * The entries a staging run verifies, as comma-separated slugs (`store-live-verify.yml`'s
   * `entries` input); empty for every entry with a source and no passing record for that source.
   */
  readonly STORE_LIVE_VERIFY_ENTRIES?: string | undefined;
  /**
   * The commit the staging deployment last seeded its demo templates from (the head of the latest
   * successful staging deploy, which `store-live-verify.yml` looks up). A staging run verifies only
   * entries whose source is the same there as in the checkout.
   */
  readonly STORE_LIVE_VERIFY_DEPLOYED_COMMIT?: string | undefined;
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

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The entries a staging run verifies, out of `live`: the entries with a source, live or coming soon
 * with its code merged (R1 comes before the flip). Named (`STORE_LIVE_VERIFY_ENTRIES`,
 * comma-separated slugs): exactly those, so a batch verifies only its own entries; a slug that is not
 * an entry with a source is refused before anything is spent. Not named: every one for which
 * `passed` says there is no passing record for its current source yet.
 */
export function entriesToVerify(
  live: readonly SourcedEntry[],
  named: string | undefined,
  passed: (entry: SourcedEntry) => boolean,
): SourcedEntry[] {
  const slugs = [
    ...new Set(
      (named ?? '')
        .split(',')
        .map((slug) => slug.trim())
        .filter((slug) => slug !== ''),
    ),
  ];
  if (slugs.length === 0) return live.filter((entry) => !passed(entry));
  const unknown = slugs.filter(
    (slug) => !SLUG.test(slug) || !live.some((entry) => entry.slug === slug),
  );
  if (unknown.length > 0) {
    // A slug is safe to echo; anything else is not repeated.
    const shown = unknown.map((slug) => (SLUG.test(slug) ? slug : '(not a slug)')).join(', ');
    throw new LiveVerifyRefusal(
      `refused: STORE_LIVE_VERIFY_ENTRIES names what is not an entry with a source: ${shown}`,
    );
  }
  return live.filter((entry) => slugs.includes(entry.slug));
}

/**
 * One run's record as the core makes it: the committed evidence's fields but the source hash, which
 * `run.ts` adds from the checkout (`./source-hash.ts`), in staging; the same fields in production.
 */
export type LiveRun<E extends LiveEnvironment> = Omit<
  RealModelRun,
  'environment' | 'sourceHash'
> & {
  readonly environment: E;
};

export interface VerifyInput<E extends LiveEnvironment> {
  readonly client: LiveClient;
  /** Every string a message must never carry; the API key at least. */
  readonly secrets: readonly string[];
  readonly entries: readonly SourcedEntry[];
  /** The clock the records' dates come from. */
  readonly now: () => Date;
  /** Where the run is made: staging for the live-verify command, production for the daily test. */
  readonly environment: E;
  /**
   * The instructions the deployed template of each entry gives its agent (the seed `run.ts` builds
   * from the checkout, which `refuseUndeployed` has matched to the deployed commit). When given, a
   * workspace copy with other instructions refuses the run before anything is spent: a workspace not
   * refilled since the deploy would otherwise have a changed entry's old copy verified.
   */
  readonly expectedInstructions?: (entry: SourcedEntry) => string;
}

/** The part of a workspace agent the harness reads. */
type WorkspaceAgent = Pick<AgentResource, 'id' | 'name' | 'instructions'>;

/**
 * Refuses, before anything is spent, when the workspace's copy of any of `entries` is not what its
 * deployed template holds (`expected`): its instructions differ. An entry with no copy is left to
 * the run, which reports it as not run.
 */
export function refuseStaleCopies(
  entries: readonly SourcedEntry[],
  agents: readonly WorkspaceAgent[],
  expected: (entry: SourcedEntry) => string,
): void {
  const stale = entries.filter((entry) => {
    const copy = agents.find((candidate) => candidate.name === entry.demo.agent);
    return copy !== undefined && copy.instructions !== expected(entry);
  });
  if (stale.length > 0) {
    throw new LiveVerifyRefusal(
      `refused: the verification workspace holds an older copy of ${stale.map((entry) => entry.slug).join(', ')}; refill it from the deployed templates first (PUT /api/demo/verification, or re-run the deploy)`,
    );
  }
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
  let agents: readonly WorkspaceAgent[];
  try {
    agents = await client.agents.list();
  } catch (error) {
    throw new LiveVerifyRefusal(
      `the deployment's agents could not be listed: ${oneLine(redact(describe(error), secrets))}`,
    );
  }
  if (input.expectedInstructions !== undefined) {
    refuseStaleCopies(entries, agents, input.expectedInstructions);
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
      // As the Try it section starts it: with the entry's output schema, when it declares one.
      const { outputSchema } = entry.demo;
      const started = await client.runs.start(agent.id, {
        prompt,
        ...(outputSchema === undefined ? {} : { outputSchema }),
      });
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
      const turn = recordTurn(prompt, runs);
      const verdict = judgeMoment(turn, check);
      records.push({
        entry: entry.slug,
        runId,
        date,
        result: verdict.pass ? 'pass' : 'fail',
        reason: verdict.pass
          ? 'the moment happened'
          : oneLine(redact(`${verdict.reason} (${trailOf(turn)})`, secrets)),
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

/**
 * What a failed turn did, short enough for a record's reason: the tools it called in order (the
 * part after `__`, a repeat counted), the calls that waited for a person, and the engine's stop
 * reason. The evidence keeps no transcript, so this is what tells an agent that stopped early from
 * one that skipped a tool or a write that ran unasked.
 */
export function trailOf(turn: RecordedTurn): string {
  const names: string[] = [];
  const counts: number[] = [];
  for (const step of turn.steps) {
    if (step.kind === 'answer') continue;
    const base = step.kind === 'tool' ? step.name : step.toolName;
    const cut = base.lastIndexOf('__');
    const short = cut === -1 ? base : base.slice(cut + 2);
    const label = step.kind === 'tool' ? (step.isError ? `${short}!` : short) : `wait:${short}`;
    const last = names.length - 1;
    if (names[last] === label) counts[last] = (counts[last] ?? 1) + 1;
    else {
      names.push(label);
      counts.push(1);
    }
  }
  const called = names
    .map((label, at) => ((counts[at] ?? 1) > 1 ? `${label}x${String(counts[at])}` : label))
    .join(', ');
  return `called: ${called === '' ? 'nothing' : called}; stop: ${turn.stopReason ?? 'none'}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** The deployed commit `env` names, or a refusal: a staging run cannot check its code without it. */
export function deployedCommitOf(env: LiveVerifyEnv): string {
  const commit = env.STORE_LIVE_VERIFY_DEPLOYED_COMMIT?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new LiveVerifyRefusal(
      'refused: STORE_LIVE_VERIFY_DEPLOYED_COMMIT must name the commit staging was deployed from',
    );
  }
  return commit;
}

/**
 * Refuses, before anything is spent, when any of `entries` is not what the deployment runs: a
 * record must verify the code the run exercised, so the template staging seeded must have been
 * built from the same source and catalog entry as the checkout whose hash the record carries.
 */
export function refuseUndeployed(
  entries: readonly SourcedEntry[],
  differs: (entry: SourcedEntry) => string | null,
): void {
  const problems = entries.flatMap((entry) => {
    const why = differs(entry);
    return why === null ? [] : [`${entry.slug}: ${why}`];
  });
  if (problems.length > 0) {
    throw new LiveVerifyRefusal(
      `refused: staging does not run the code checked out; deploy it first (${problems.join('; ')})`,
    );
  }
}

/**
 * The source hash of each entry, taken before anything is spent: an entry with no source to hash
 * cannot get a record that verifies it, so the run is refused.
 */
export function sourceHashesOf(
  entries: readonly SourcedEntry[],
  hashOf: (entry: SourcedEntry) => string | null,
): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>();
  for (const entry of entries) {
    const hash = hashOf(entry);
    if (hash === null) {
      throw new LiveVerifyRefusal(
        `refused: ${entry.slug} has no source to hash at ${entry.source}`,
      );
    }
    hashes.set(entry.slug, hash);
  }
  return hashes;
}

/** The staging records as the committed evidence keeps them, each with its entry's source hash. */
export function withSourceHashes(
  records: readonly LiveRun<'staging'>[],
  hashes: ReadonlyMap<string, string>,
): RealModelRun[] {
  return records.map((record) => {
    const sourceHash = hashes.get(record.entry);
    if (sourceHash === undefined) {
      throw new LiveVerifyRefusal(`refused: ${record.entry} ran with no source hash taken`);
    }
    return { ...record, sourceHash };
  });
}

/** The evidence with `records` after its earlier records, which are never rewritten. */
export function appendEvidence(
  existing: RealModelEvidence,
  records: readonly RealModelRun[],
): RealModelEvidence {
  return realModelEvidenceSchema.parse({ runs: [...existing.runs, ...records] });
}
