// Runs the Builder's eval set for builder-evals.yml as the stack's setup Owner, signed in. The
// Builder acts only for a person: a run started with an API key and no subject has no caller, and
// every aw-control call it makes is refused (`not_permitted`). So the cases run through the Owner's
// session, which makes each case's run the member's own.
//
// `aw eval builder --json --min-score 0 --junit <file>` runs in process, unchanged: same case file,
// same requests, same retries, same report. Only its `fetch` differs: `aw` has no session login, so
// it is given a placeholder key, and every request it sends drops that placeholder for the Owner's
// session cookie and the stack's `Origin` (the same-origin check on writes). A request to another
// origin, or one carrying any other credential, is refused before it is sent.
//
// The cookie reaches this process as a file setup wrote (mode 600, outside the uploaded directory),
// never by argument or log. Writes `report.json` and `junit.xml` to OUT_DIR as `aw` would, and exits
// with `aw`'s code.
//
// With `--transcripts` it instead writes each case run's events from OUT_DIR/report.json to
// OUT_DIR/transcripts/<runId>.json. That is its own workflow step, with its own timeout, run after
// the evals whatever their exit code: a failed gate is when the transcripts are wanted most, and
// reading them must not spend the evals' budget (EVL-04).
/* global AbortSignal, fetch, Headers, URL */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** What `aw` is given as its key; it never leaves this process. */
export const PLACEHOLDER_KEY = 'owner-session-placeholder';

/** How long one finished run's events may take to replay. */
const TRANSCRIPT_TIMEOUT_MS = 60_000;

/** How long all the transcripts together may take; the workflow step's timeout is above it. */
const TRANSCRIPTS_BUDGET_MS = 8 * 60_000;

/**
 * A `fetch` that sends `cookie` and `origin` to `baseUrl`'s origin only, in place of the
 * placeholder key (or no credential at all).
 * @param {typeof fetch} base
 * @param {{ baseUrl: string, cookie: string }} session
 * @returns {typeof fetch}
 */
export function sessionFetch(base, { baseUrl, cookie }) {
  const { origin } = new URL(baseUrl);
  return (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      return Promise.reject(new TypeError('sessionFetch takes a URL, not a Request'));
    }
    const target = new URL(input);
    if (target.origin !== origin) {
      return Promise.reject(new Error(`refused to send the Owner session to ${target.origin}`));
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization');
    if (authorization !== null && authorization !== `Bearer ${PLACEHOLDER_KEY}`) {
      return Promise.reject(new Error('refused a request that carries another credential'));
    }
    headers.delete('authorization');
    headers.set('cookie', cookie);
    headers.set('origin', origin);
    // The session never follows a redirect, wherever it points.
    return base(target, { ...init, headers, redirect: 'error' });
  };
}

/**
 * Each case's run, in report order: the evaluation's results with a `runId`.
 * @param {{ results?: readonly { name: string, runId: string | null }[] }} report
 * @returns {{ name: string, runId: string }[]}
 */
export function caseRuns(report) {
  return (report.results ?? []).flatMap(({ name, runId }) =>
    typeof runId === 'string' ? [{ name, runId }] : [],
  );
}

/**
 * Write each case run's events to `<dir>/<runId>.json`. A run whose events cannot be read gets a
 * file with the frames read so far and the error, and is named in the answer; the gate reads the
 * report, not these. Each run has `timeoutMs`, and all of them together `budgetMs`: once it is spent
 * the runs left get a file with no frames and that error, so a stack that stopped answering costs
 * the budget, not `timeoutMs` for every run.
 * @param {{ runs: { events: (runId: string, options: { signal: AbortSignal }) => AsyncIterable<unknown> } }} client
 * @param {{ name: string, runId: string }[]} runs
 * @param {string} dir
 * @param {{ timeoutMs?: number, budgetMs?: number, now?: () => number }} [options]
 * @returns {Promise<string[]>} the run ids whose transcript is incomplete
 */
export async function writeTranscripts(client, runs, dir, options = {}) {
  const {
    timeoutMs = TRANSCRIPT_TIMEOUT_MS,
    budgetMs = TRANSCRIPTS_BUDGET_MS,
    now = Date.now,
  } = options;
  await mkdir(dir, { recursive: true });
  const deadline = now() + budgetMs;
  const incomplete = [];
  for (const { name, runId } of runs) {
    const frames = [];
    let error;
    const remaining = deadline - now();
    if (remaining <= 0) {
      error = 'the transcript budget was spent before this run was read';
      incomplete.push(runId);
    } else {
      try {
        for await (const frame of client.runs.events(runId, {
          signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
        })) {
          frames.push(frame);
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        incomplete.push(runId);
      }
    }
    const transcript = { case: name, runId, frames, ...(error === undefined ? {} : { error }) };
    await writeFile(
      path.join(dir, `${path.basename(runId)}.json`),
      `${JSON.stringify(transcript, null, 2)}\n`,
      'utf8',
    );
  }
  return incomplete;
}

/**
 * The case runs in `<outDir>/report.json`, or none when the evals left no readable report (`aw`
 * failed before it wrote one): the step then has nothing to keep, and says so rather than failing
 * on top of the evals' own failure.
 * @param {string} outDir
 * @returns {Promise<{ name: string, runId: string }[]>}
 */
export async function reportRuns(outDir) {
  try {
    return caseRuns(JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8')));
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const { AGENT_WORKSPACE_URL: baseUrl, OWNER_SESSION_FILE, OUT_DIR } = process.env;
  if (!baseUrl || !OWNER_SESSION_FILE || !OUT_DIR) {
    process.stderr.write(
      'usage: AGENT_WORKSPACE_URL=… OWNER_SESSION_FILE=… OUT_DIR=… node run-evals.mjs [--transcripts]\n',
    );
    process.exit(2);
  }
  const cookie = (await readFile(OWNER_SESSION_FILE, 'utf8')).trim();
  const ownerFetch = sessionFetch(fetch, { baseUrl, cookie });
  await mkdir(OUT_DIR, { recursive: true });

  if (process.argv.includes('--transcripts')) {
    const { createClient } = await import('@indx-workspace/sdk');
    const client = createClient({ baseUrl, auth: { kind: 'session' }, fetch: ownerFetch });
    const runs = await reportRuns(OUT_DIR);
    const incomplete = await writeTranscripts(client, runs, path.join(OUT_DIR, 'transcripts'));
    for (const runId of incomplete) {
      process.stdout.write(
        `::warning title=Transcript incomplete::run ${runId}'s events could not all be read; its file has the error\n`,
      );
    }
    process.stdout.write(
      `kept ${String(runs.length - incomplete.length)} of ${String(runs.length)} case transcript(s)\n`,
    );
  } else {
    const { main } = await import('@indx-workspace/aw');
    // An empty home: no profile or stored login of this machine is read.
    const home = await mkdtemp(path.join(tmpdir(), 'builder-evals-aw-'));
    let stdout = '';
    const exitCode = await main(
      ['eval', 'builder', '--json', '--min-score', '0', '--junit', path.join(OUT_DIR, 'junit.xml')],
      {
        stdin: () => Promise.resolve(''),
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => process.stderr.write(text),
        env: { AGENT_WORKSPACE_URL: baseUrl, AGENT_WORKSPACE_API_KEY: PLACEHOLDER_KEY },
        homeDir: home,
        fetch: ownerFetch,
        isTty: false,
        // The project whose evals/builder.yaml `aw eval builder` reads.
        cwd: fileURLToPath(new URL('..', import.meta.url)),
      },
    );
    await rm(home, { recursive: true, force: true });
    await writeFile(path.join(OUT_DIR, 'report.json'), stdout, 'utf8');
    if (exitCode !== 0) process.exit(exitCode);
  }
}
