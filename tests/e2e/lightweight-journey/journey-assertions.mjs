import { redact } from '../../../infra/tests/providers/support.mjs';
import { assistantText, terminalStatus } from '../../generated-project/stack-api.mjs';
import { check } from '../build-deploy-journey/journey.e2e.mjs';

export const SECRET_FIELD = /token|key|secret|password|credential/iu;

/**
 * Every string a JSON answer carries under a field named like a credential (`token`, `apiKey`,
 * `secret`, `password`, ...), at any depth, including the items of an array in such a field.
 * Short values are skipped: redacting them would mangle ordinary words in the log.
 *
 * @param {unknown} value
 * @param {boolean} [named] whether `value` sits under a credential-named field
 * @returns {string[]}
 */
export function responseSecrets(value, named = false) {
  if (typeof value === 'string') return named && value.length >= 8 ? [value] : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([name, child]) =>
    responseSecrets(child, Array.isArray(value) ? named : SECRET_FIELD.test(name)),
  );
}

/**
 * `check` that redacts its message with `hidden()` first, so an `ok:` line never prints a
 * credential. The shared `check` prints every passing message as it is.
 *
 * @param {() => readonly string[]} hidden @param {typeof check} [print]
 */
export function redactingCheck(hidden, print = check) {
  return (/** @type {boolean} */ ok, /** @type {string} */ message) =>
    print(ok, redact(message, [...hidden()]));
}

/**
 * What the control plane stored for a run that did not complete: its status and its public error,
 * which names the failing hop (`The runtime could not be reached.`, ...). The server log holds the
 * cause; this is the only part of it that is safe to print. Redacted with `secrets` and capped.
 *
 * @param {{ request: (route: string, options?: { apiKey?: string }) => Promise<{ status: number, json: any }> }} client
 * @param {string} runId @param {readonly string[]} secrets @param {string} [apiKey]
 */
export async function failedRunDetail(client, runId, secrets, apiKey) {
  let answer;
  try {
    answer = await client.request(`/api/runs/${runId}`, apiKey === undefined ? {} : { apiKey });
  } catch {
    return 'run detail unavailable';
  }
  const run = answer.json?.run;
  const detail =
    answer.status === 200
      ? `status=${String(run?.status)} error=${String(run?.error)}`
      : `status=${String(answer.status)}`;
  return redact(detail.replace(/\p{Cc}/gu, ' '), [...secrets]).slice(0, 300);
}

/**
 * The proof a lane whose runtime refuses every run (ADR-0131) records `n/a` on: the typed code in the
 * start answer, or in the frames of a run that did not complete. Anything else is a failure.
 *
 * @param {string} code @param {{ status: number, text: string }} started
 * @param {() => Promise<any[]>} framesOf @param {(ok: boolean, message: string) => void} [report]
 */
export async function refusedRun(code, started, framesOf, report = check) {
  const seen = started.status === 202 ? await framesOf() : [started.text];
  const text = JSON.stringify(seen);
  report(
    text.includes(code) &&
      (started.status === 202 ? terminalStatus(seen) !== 'completed' : started.status === 422),
    `the run was refused with ${code} (${String(started.status)} ${text.slice(-300)})`,
  );
  return `n/a: the first run was refused with ${code} (ADR-0131) and nothing ran`;
}

/**
 * The proof a lane with no tool sandbox records `n/a` on for `aw push`: every problem line is the
 * typed `422 <code>` refusal and there is at least one. Any other problem line (a 503, another
 * code) fails, so only the expected refusal is excused.
 *
 * @param {string} code @param {string} output what `aw push --yes` printed
 * @param {(ok: boolean, message: string) => void} [report]
 */
export function refusedPush(code, output, report = check) {
  const problems = output.split('\n').filter((line) => /^\S+: (?:\d{3}|local) [a-z_]+/u.test(line));
  report(
    problems.length > 0 &&
      problems.every((line) => new RegExp(`^\\S+: 422 ${code}\\b`, 'u').test(line)),
    `aw push was refused with ${code} only (${output.slice(-500)})`,
  );
  // A problem in another shape (`✗ file:line:col  …`) is not matched above; the count line catches it.
  const count = /^(?:error: )?(\d+) problems?$/mu.exec(output)?.[1];
  report(
    count === undefined || Number(count) === problems.length,
    `aw push printed ${String(count)} problem(s) but ${String(problems.length)} refusal line(s) (${output.slice(-500)})`,
  );
  return `n/a: aw push was refused with ${code} (ADR-0131) and no agent was created`;
}

/**
 * One turn the way the project frontend's client sends it (`client.runs.start` of
 * `@indx-workspace/react`): `POST /api/agents/<agent>/runs` from the frontend origin, the visitor
 * token as Bearer, `{ prompt, sessionId }`. The run must be accepted with CORS for that origin (a
 * browser there could not read the answer otherwise), complete, and reply with the code tool's data.
 *
 * @param {{
 *   control: string, origin: string, nonce: string,
 *   session: { token: string, sessionId: string, agentId: string },
 *   ask: (url: string, init: RequestInit) => Promise<{ status: number, text: string, headers: Headers, json: any }>,
 *   framesOf: (runId: string) => Promise<any[]>,
 *   detailOf?: (runId: string) => Promise<string>,
 *   report?: (ok: boolean, message: string) => void,
 * }} options
 */
export async function frontendTurn({
  control,
  origin,
  nonce,
  session,
  ask: send,
  framesOf,
  detailOf = () => Promise.resolve(''),
  report = check,
}) {
  const started = await send(`${control}/api/agents/${session.agentId}/runs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt: `Look up order ${nonce} with your order tool and repeat the tool output exactly.`,
      sessionId: session.sessionId,
    }),
  });
  report(
    started.status === 202,
    `the frontend's run was accepted (${String(started.status)} ${started.text.slice(0, 200)})`,
  );
  const allowed = started.headers.get('access-control-allow-origin');
  report(allowed === origin, `the run answer allows the frontend origin (${String(allowed)})`);
  const runId = String(started.json?.run?.id);
  const frames = await framesOf(runId);
  const completed = terminalStatus(frames) === 'completed';
  report(completed, `the frontend's run completed (${completed ? '' : await detailOf(runId)})`);
  report(
    assistantText(frames).includes(`order-data-${nonce}`),
    "the frontend's reply carries the code tool's data",
  );
}

/**
 * Setup answered 201, and recorded the runtime's refusal exactly when the lane expects one: a lane
 * whose runtime refuses every network policy (ADR-0131) completes setup with that recorded state.
 *
 * @param {string | undefined} refusal @param {{ status: number, text: string, json: any }} setup @param {(ok: boolean, message: string) => void} [report]
 */
export function setupAnswered(refusal, setup, report = check) {
  report(
    setup.status === 201,
    `setup answered ${String(setup.status)} ${setup.text.slice(0, 300)}`,
  );
  const recorded = setup.json?.runtimeRefusal ?? null;
  report(
    refusal === undefined
      ? recorded === null
      : recorded?.code === refusal && String(recorded.message).includes('ADR-0131'),
    `setup recorded the runtime refusal ${String(refusal ?? 'none')} (${JSON.stringify(recorded)})`,
  );
}
