import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  EVALUATION_CASE_LIMIT,
  EVALUATION_RUBRIC_MAX_LENGTH,
  EvalCaseFileSchema,
  type EvalCase,
  type EvaluationResource,
  type EvaluationRunResource,
} from '@indx-workspace/contracts/evaluations';
import { ApiProblemError, TransportError } from '@indx-workspace/sdk';
import { appendEvalCase, ProjectFileError, readEvalCaseFile } from '@indx-workspace/sdk/project';

import {
  command,
  isOn,
  positional,
  singleValue,
  value,
  type ApiCommand,
  type CommandContext,
  type CommandResult,
  type LocalCommand,
  type LocalCommandContext,
} from '../command.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { modelFixFor, notice, writeResult } from '../output.js';
import { evalAgents, evalCaseFileLabel, loadEvalCases } from '../project/index.js';
import { versionNumberOf } from './agent-versions.js';
import {
  diffAgainst,
  diffLines,
  junit,
  parseMinScore,
  scoreOf,
  type BaselineDiff,
} from './eval-report.js';
import { projectRoot } from './project.js';

/** The id of the workspace's agent named `name`, found by its exact name (or, failing that, its id). */
function idIn(agents: readonly { id: string; name: string }[], name: string): string {
  const agent =
    agents.find((candidate) => candidate.name === name) ??
    agents.find((candidate) => candidate.id === name);
  if (agent === undefined) {
    throw new CommandRefusedError(`no agent named ${JSON.stringify(name)}`, 'run aw push --yes');
  }
  return agent.id;
}

export async function agentIdNamed(context: CommandContext, name: string): Promise<string> {
  return idIn(await context.client.agents.list({ signal: context.signal }), name);
}

/** The version the `local` environment points at: the default when none is named. */
async function localVersionOf(context: CommandContext, agentId: string): Promise<number> {
  const list = await context.client.agents.versions.list(agentId, { signal: context.signal });
  const local = list.pointers.find((pointer) => pointer.environment === 'local');
  if (local === undefined) {
    throw new CommandRefusedError('local points at no version yet', 'run aw push --yes');
  }
  return local.number;
}

/** Issue #736: the sentence and next step for a judge failure code; other failures print as they are. */
const JUDGE_FAILURE_TEXT: Readonly<Record<string, string>> = {
  judge_unparseable:
    "judge: the judge model's reply could not be read as pass/fail, so the case counts as failed. " +
    'Retry, or check the model connection.',
  judge_unavailable:
    'judge: the judge model could not be reached, so the case counts as failed. ' +
    'Retry, or check the model connection.',
};

/** One agent's block: a header, a line per case with the failing reason, and the tally. */
function agentBlock(
  name: string,
  local: boolean,
  evaluation: EvaluationResource,
  runErrors: ReadonlyMap<string, string>,
): string {
  const { version, total, passed, results, id } = evaluation;
  const where = local ? ' (local)' : '';
  const cases = total === 1 ? 'case' : 'cases';
  return [
    `${name} v${String(version)}${where} · ${String(total)} ${cases}`,
    ...results.flatMap((result) => {
      const line =
        `  ${result.passed ? '✓' : '✗'} ${result.name}` +
        (result.failures.length === 0
          ? ''
          : `   ${result.failures.map((failure) => JUDGE_FAILURE_TEXT[failure] ?? failure).join('; ')}`);
      const error = result.runId === null ? undefined : runErrors.get(result.runId);
      return error === undefined ? [line] : [line, `      run ${String(result.runId)}: ${error}`];
    }),
    `  ${String(passed)}/${String(total)} passed · evaluation ${id}`,
    '',
  ].join('\n');
}

/** A failure that is only the run's status (`run_failed`): the run's own error says which hop failed. */
const UNCODED_RUN_FAILURE = /^run_[a-z_]+$/u;

/**
 * The public error of each failed case's run, by run id, for the cases with an uncoded
 * `run_<status>` failure (`run_failed`, `run_cancelled`, `run_stream_failed`, ...) among their
 * failures. It is already safe to show (the server stores a fixed sentence per hop). A run that
 * cannot be fetched adds nothing, so the verdict and exit code do not depend on it.
 */
async function runErrorsOf(
  context: CommandContext,
  evaluation: EvaluationResource,
): Promise<ReadonlyMap<string, string>> {
  const errors = new Map<string, string>();
  for (const { passed, runId, failures } of evaluation.results) {
    if (
      passed ||
      runId === null ||
      !failures.some((failure) => UNCODED_RUN_FAILURE.test(failure))
    ) {
      continue;
    }
    try {
      const { error } = await context.client.runs.get(runId, { signal: context.signal });
      const printable = error?.replace(/\p{Cc}/gu, ' ').trim();
      if (printable !== undefined && printable !== '') errors.set(runId, printable);
    } catch {
      context.signal.throwIfAborted();
    }
  }
  return errors;
}

/** A busy run is retried this often, for about as long as the server's lease (230 s) lasts. */
const BUSY_RETRY_MS = 5_000;
const BUSY_RETRIES = 48;

function sleep(context: CommandContext, milliseconds: number): Promise<void> {
  return context.io.sleep === undefined
    ? delay(milliseconds, undefined, { signal: context.signal })
    : context.io.sleep(milliseconds, context.signal);
}

/** A connection that dropped before any answer is retried this often. */
const TRANSPORT_RETRIES = 3;

/**
 * Advance `runId` once. `409 evaluation_run_busy` means an earlier advance still holds the lease,
 * e.g. one whose connection a proxy cut while the server kept running it, so wait and try again.
 * So does a `TransportError` that was not an abort: advancing resumes at the first case without a
 * stored result, so repeating it is safe.
 */
async function advanceOnce(
  context: CommandContext,
  agentId: string,
  runId: string,
): Promise<EvaluationRunResource> {
  const options = { signal: context.signal };
  let busy = 0;
  let dropped = 0;
  for (;;) {
    try {
      return await context.client.agents.evaluations.advanceRun(agentId, runId, options);
    } catch (error) {
      if (error instanceof ApiProblemError && error.code === 'evaluation_run_busy') {
        busy += 1;
        if (busy > BUSY_RETRIES) throw error;
      } else if (error instanceof TransportError && !error.aborted) {
        dropped += 1;
        if (dropped > TRANSPORT_RETRIES) throw error;
        busy = 0; // the dropped advance may hold a fresh lease: wait out a whole one again
      } else {
        throw error;
      }
      await sleep(context, BUSY_RETRY_MS);
    }
  }
}

/**
 * Whether `error` is a server without the evaluation-run routes (before #799): Next.js answers an
 * unknown route with its HTML 404 page, not the platform's envelope, unlike a `404` of the route.
 */
function evaluationRunsMissing(error: unknown): boolean {
  return (
    error instanceof ApiProblemError &&
    error.status === 404 &&
    error.code === 'unrecognised_error_body'
  );
}

/**
 * One agent's evaluation: an evaluation run that this advances, step by step, until it completes
 * (issue #799, #832), so no request has to outlive a host's request limit. A run gives every case
 * its own deadline; the synchronous request shared one budget across the whole file, so the last
 * cases of a slow agent ended `deadline_exceeded` (issue #1021). An interrupted run is left on the
 * server, and its id printed. A server without evaluation runs gets the synchronous
 * evaluation it served before, for a file of up to {@link EVALUATION_CASE_LIMIT} cases.
 */
async function evaluate(
  context: CommandContext,
  agentName: string,
  agentId: string,
  request: { readonly version: number; readonly cases: readonly EvalCase[] },
): Promise<EvaluationResource> {
  const { evaluations } = context.client.agents;
  const options = { signal: context.signal };
  let run: EvaluationRunResource;
  try {
    run = await evaluations.createRun(agentId, request, options);
  } catch (error) {
    if (!evaluationRunsMissing(error) || request.cases.length > EVALUATION_CASE_LIMIT) throw error;
    return evaluations.create(agentId, request, options);
  }
  try {
    while (run.status !== 'completed') {
      run = await advanceOnce(context, agentId, run.id);
      notice(
        context.io,
        context.mode,
        `${agentName}: ${String(run.results.length)}/${String(run.total)} cases`,
      );
    }
  } catch (error) {
    notice(
      context.io,
      context.mode,
      `${agentName}: evaluation ${run.id} stopped at ${String(run.results.length)}/${String(run.total)} cases`,
    );
    throw error;
  }
  // `--json` keeps the shape of a synchronous evaluation.
  const { id, agentId: runAgentId, version, score, passed, total, results, createdAt } = run;
  return { id, agentId: runAgentId, version, score, passed, total, results, createdAt };
}

/** Issue #661: a case that failed on the model setup gets the fix line `aw runs start` prints. */
function fixFor(evaluations: readonly EvaluationResource[]): string | undefined {
  return evaluations
    .flatMap((evaluation) => evaluation.results)
    .flatMap((result) => result.failures)
    .map(modelFixFor)
    .find((line) => line !== undefined);
}

async function runEval(context: CommandContext): Promise<undefined> {
  const root = projectRoot(context);
  const named = context.positionals[0];
  const minScoreFlag = value(context, 'min-score');
  const minScore = minScoreFlag === undefined ? undefined : parseMinScore(minScoreFlag);
  const junitFile = value(context, 'junit');
  if (junitFile?.trim() === '') throw new UsageError('--junit must not be empty');
  const baselineId = value(context, 'baseline');
  if (baselineId?.trim() === '') throw new UsageError('--baseline must not be empty');
  // No agent named: every agent with an evals file, each on the draft `local` points at.
  const agentNames = named === undefined ? await evalAgents(root) : [named];
  if (baselineId !== undefined && agentNames.length !== 1) {
    throw new UsageError(
      '--baseline compares one agent: name it, aw eval run <agent> --baseline <id>',
    );
  }
  // Resolve every agent before the first evaluation is created, so a stale file stops the run
  // before the server stores anything.
  const given = context.positionals[1] !== undefined;
  const loaded = [];
  for (const agentName of agentNames) {
    loaded.push({ agentName, cases: (await loadEvalCases(root, agentName)).cases });
  }
  const agents = await context.client.agents.list({ signal: context.signal });
  const planned = loaded.map((each) => ({ ...each, agentId: idIn(agents, each.agentName) }));
  const baseline =
    baselineId === undefined || planned[0] === undefined
      ? undefined
      : await context.client.agents.evaluations.getRun(planned[0].agentId, baselineId, {
          signal: context.signal,
        });
  if (baseline !== undefined && baseline.status !== 'completed') {
    throw new CommandRefusedError(`baseline ${baseline.id} has not completed`);
  }
  const text = !context.mode.json && !context.mode.jsonl;
  const evaluations: EvaluationResource[] = [];
  const suites: { name: string; evaluation: EvaluationResource }[] = [];
  const diffs: BaselineDiff[] = [];
  for (const { agentName, cases, agentId } of planned) {
    const version = given ? versionNumberOf(context, 1) : await localVersionOf(context, agentId);
    const evaluation = await evaluate(context, agentName, agentId, { version, cases });
    evaluations.push(evaluation);
    suites.push({ name: agentName, evaluation });
    if (text) {
      context.io.stdout(
        agentBlock(agentName, !given, evaluation, await runErrorsOf(context, evaluation)),
      );
    }
    if (baseline !== undefined) {
      const diff = diffAgainst(baseline, evaluation);
      diffs.push(diff);
      if (text) context.io.stdout(diffLines(diff, evaluation).join('\n'));
    }
  }
  if (junitFile !== undefined) {
    // Written whether or not the run failed: a CI step publishes it either way.
    const target = path.resolve(root, junitFile);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, junit(suites), 'utf8');
  }
  if (!text) {
    // An agent named: its evaluation. None named: a list, whatever the number of evals files, so
    // a script's parse does not change when a second agent gets one.
    const [only] = evaluations;
    const withBaseline = diffs[0] === undefined ? only : { ...only, baseline: diffs[0] };
    writeResult(context.io, context.mode, named === undefined ? evaluations : withBaseline);
  }
  if (minScore !== undefined) {
    const lowest = Math.min(...evaluations.map(scoreOf));
    if (lowest < minScore) {
      throw new CommandRefusedError(
        `score ${String(Number(lowest.toFixed(4)))} is below --min-score ${String(minScore)}`,
        fixFor(evaluations),
      );
    }
    return undefined;
  }
  const total = evaluations.reduce((sum, evaluation) => sum + evaluation.total, 0);
  const failed = total - evaluations.reduce((sum, evaluation) => sum + evaluation.passed, 0);
  if (failed > 0) {
    throw new CommandRefusedError(
      `${String(failed)} of ${String(total)} cases failed`,
      fixFor(evaluations),
    );
  }
  return undefined;
}

const JUDGE_PREFIX = 'Must not repeat: ';

/**
 * The judge rubric a rater's comment becomes. The comment says what was wrong, so it is framed as
 * the fault to avoid: taken as the rubric itself, "Too long." would pass a long answer (BH061-049).
 */
function commentRubric(comment: string): string {
  const rubric = `An earlier answer was rated down with: "${comment}". Pass only if this answer does not have that problem.`;
  return rubric.length <= EVALUATION_RUBRIC_MAX_LENGTH
    ? rubric
    : `${JUDGE_PREFIX}${comment}`.slice(0, EVALUATION_RUBRIC_MAX_LENGTH).trimEnd();
}

/**
 * The case a thumbs-down on `runId` becomes (issue #620): the run's prompt as the input, and as the
 * judge the rater's comment, framed as the fault to avoid, or else the answer it must not give again.
 */
async function caseFromRun(context: CommandContext, runId: string, agentId: string) {
  const [rating] = await context.client.agents.feedback.list(
    agentId,
    { runId, rating: 'down' },
    { signal: context.signal },
  );
  if (rating === undefined) throw new CommandRefusedError(`run ${runId} has no thumbs-down`);
  if (rating.input === null) {
    throw new CommandRefusedError(`run ${runId} was recorded before prompts were stored`);
  }
  if (rating.comment === null && rating.answer.trim() === '') {
    throw new CommandRefusedError(`run ${runId} has neither a comment nor an answer to judge by`);
  }
  const judge =
    rating.comment === null
      ? `${JUDGE_PREFIX}${rating.answer}`.slice(0, EVALUATION_RUBRIC_MAX_LENGTH).trimEnd()
      : commentRubric(rating.comment);
  const added = {
    name: `run ${runId.slice(0, 8)}`,
    input: rating.input,
    expect: { judge },
    fromRun: runId,
  } satisfies EvalCase;
  return added;
}

/** `record` without its absent optional keys, which the YAML writer refuses. */
function defined<T>(record: Readonly<Record<string, T | undefined>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]): [string, T][] =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

/** The lines that differ between `before` and `after`, as `-` and `+` lines between their common ends. */
function lineDiff(label: string, before: string, after: string): string {
  const a = before === '' ? [] : before.trimEnd().split('\n');
  const b = after.trimEnd().split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return [
    `--- ${label}`,
    `+++ ${label}`,
    ...a.slice(head, a.length - tail).map((line) => `-${line}`),
    ...b.slice(head, b.length - tail).map((line) => `+${line}`),
  ].join('\n');
}

/**
 * `aw eval add-case <runId> [--yes]` (issue #620): append the case a thumbs-down on the run becomes
 * to `evals/<agent>.yaml`, creating it if needed. Prints the diff, and writes only with `--yes`.
 * The case is appended through the YAML document, so the file's comments and order survive.
 */
async function addCase(context: CommandContext): Promise<CommandResult | undefined> {
  const runId = positional(context, 0, 'runId');
  const run = await context.client.runs.get(runId, { signal: context.signal });
  const agent = await context.client.agents.get(run.agentId, { signal: context.signal });
  const label = evalCaseFileLabel(agent.name);
  const root = projectRoot(context);
  const file = path.join(root, label);
  const exists = await access(file).then(
    () => true,
    () => false,
  );
  const before = exists ? await readFile(file, 'utf8') : '';
  const existing = exists ? (await loadEvalCases(root, agent.name)).cases : [];
  if (existing.some((each) => each.fromRun === run.id)) {
    throw new CommandRefusedError(`run ${run.id} is already a case in ${label}`);
  }
  const added = await caseFromRun(context, run.id, agent.id);
  const parsed = EvalCaseFileSchema.safeParse({ cases: [...existing, added] });
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new CommandRefusedError(
      `the case cannot be added to ${label}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`,
    );
  }
  const after = appendEvalCase(before, added, label);
  const json = context.mode.json || context.mode.jsonl;
  const written = isOn(context, 'yes');
  if (!json) context.io.stdout(`${lineDiff(label, before, after)}\n`);
  if (written) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, after, 'utf8');
  }
  if (json) return { value: { file: label, case: added, written } };
  notice(
    context.io,
    context.mode,
    written ? `wrote ${label}` : `nothing was written: run aw eval add-case ${runId} --yes`,
  );
  return undefined;
}

const CASE_NAME_MAX = 60;

/**
 * `aw eval add "<input>" [--agent <name>] [--expect-contains <text>]... [--expect-tool <name>]`
 * (issue #698): append a case to `evals/<agent>.yaml` locally, keeping its comments and order, and
 * creating the file if the agent has none. The agent is `--agent`, else the only evals file's. The
 * case is named by its input; the file as it would be must parse, or nothing is written.
 */
async function addInput(context: LocalCommandContext): Promise<void> {
  // `positional`, `value` and `values` take an API command's context; a local one reads `args`.
  const [input] = context.positionals;
  if (input === undefined || input.trim() === '') throw new UsageError('missing <input>');
  const root = context.cwd;
  if (root === undefined) throw new CommandRefusedError('there is no current directory to load');
  const given = singleValue(context, 'agent');
  const agentName = given ?? (await soleAgentForAdd(root));
  const label = evalCaseFileLabel(agentName);
  const file = path.join(root, label);
  const before = await readFile(file, 'utf8').catch(() => '');
  const contains = context.args.repeatableValues.get('expect-contains') ?? [];
  const tool = context.args.values.get('expect-tool');
  const name = input.replaceAll(/\s+/gu, ' ').trim().slice(0, CASE_NAME_MAX).trimEnd();
  const added = {
    name,
    input,
    expect: defined({ contains: contains.length === 0 ? undefined : contains, tool }),
  };
  let after: string;
  try {
    after = appendEvalCase(before, added, label);
    readEvalCaseFile(after, label);
  } catch (error) {
    if (error instanceof ProjectFileError) throw new UsageError(error.message);
    throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, after, 'utf8');
  if (context.mode.json || context.mode.jsonl) {
    writeResult(context.io, context.mode, { file: label, case: added });
    return;
  }
  notice(context.io, context.mode, `added "${name}" to ${label}`);
}

/** The only evals file's agent, or a usage error that names `--agent`, which `eval add` takes. */
async function soleAgentForAdd(root: string): Promise<string> {
  const names = await evalAgents(root).catch(() => []);
  const [only] = names;
  if (only !== undefined && names.length === 1) return only;
  throw new UsageError(
    names.length === 0
      ? 'name the agent with --agent <name>; it creates evals/<name>.yaml'
      : `name the agent with --agent <name> (found ${names.map((each) => `${each}.yaml`).join(', ')})`,
  );
}

/**
 * Issue #618: `aw eval [agent] [version]` runs `evals/<agent>.yaml`'s cases against a version of
 * the agent on the server, which scores and stores the evaluation. It exits 1 when any case
 * fails, so a CI step can gate on it. The version is a positional because `--version` is the
 * global switch; it defaults to the one `local` points at.
 *
 * Issue #799: `aw eval run` is the same command; `--min-score <0..1>` replaces "any case fails"
 * with a score threshold, `--junit <file>` writes a JUnit report, and `--baseline <id>` prints the
 * per-case difference from an earlier evaluation of the agent.
 */
export const evalCommands: readonly (ApiCommand | LocalCommand)[] = [
  command(
    'eval',
    '[agent] [version] [--min-score <0..1>] [--junit <file>] [--baseline <id>] [--json]',
    "Run evals/<agent>.yaml's cases against a version on the server and store the score",
    runEval,
  ),
  command(
    'eval run',
    '[agent] [version] [--min-score <0..1>] [--junit <file>] [--baseline <id>] [--json]',
    'Same as aw eval; takes up to 200 cases and follows the run until it completes',
    runEval,
  ),
  command(
    'eval add',
    '<input> [--agent <name>] [--expect-contains <text>]... [--expect-tool <name>] [--json]',
    'Append a case to evals/<agent>.yaml, keeping its comments; nothing is sent to the server',
    { controlPlane: 'none', run: addInput },
  ),
  command(
    'eval add-case',
    '<runId> [--yes]',
    'Show the evaluation case a thumbs-down on a run becomes, and append it with --yes',
    addCase,
  ),
];
