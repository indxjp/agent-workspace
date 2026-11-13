/**
 * The journey's first half: B1 (the four commands a new user runs, on the 600 s clock), the
 * untimed checks on that first `aw dev`, and the restart that must keep the persisted connection.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { URL } from 'node:url';

import {
  JOURNEY_BRAND_COLOUR,
  JOURNEY_BUDGET_SECONDS,
  JourneyFailure,
  agentIdOf,
  agentNameOfSource,
  assertReplyRecorded,
  assertUnchanged,
  assertWithinBudget,
  stepSummaryMarkdown,
  timingsReport,
  totalLine,
} from './harness.mjs';
import { agentFile, checkMcpOnPi, versionsOf } from './run-checks.mjs';
import { startDev } from './run-dev.mjs';
import {
  checkAllowedOrigins,
  checkFeedbackFails,
  checkPinnedVersion,
  checkPromoteRollback,
  checkRunFiles,
  checkViewerForbidden,
  widgetTest,
} from './run-specs.mjs';
import {
  CREATE_PACKAGE,
  DEMO_IN,
  WORK_IN,
  appendSummary,
  checksLimit,
  execAnswering,
  execOk,
  nonce,
  promptOf,
  say,
  snapshotDemo,
} from './run-support.mjs';
import { newProgress, recordFirstToken, timedStep, writeTimings } from './run-timing.mjs';

/**
 * What the phases of one run share. `timing` is B1's progress and `timings` the record every later
 * block adds to; both are set when B1 starts and when it has reported.
 *
 * @typedef {{
 *   machine: string, work: string, evidence: string, live: boolean, checksMs: number,
 *   anthropic: Record<string, string>, fakeKey: string,
 *   requests: import('../generated-project/fake-anthropic.mjs').FakeRequestRecord[],
 *   toolRequests: import('./fake-anthropic-tools.mjs').ToolRequestRecord[],
 *   bodies: string[],
 *   calls: import('./fake-anthropic-tools.mjs').OrdersCall[],
 *   ordersApi: ReturnType<typeof import('./fake-anthropic-tools.mjs').createOrdersApi>,
 *   ordersOrigin: string,
 *   devs: ReturnType<typeof startDev>[],
 *   timing?: import('./run-timing.mjs').JourneyProgress,
 *   timings?: import('./run-timing.mjs').JourneyTimings,
 * }} JourneyContext
 */

/**
 * The record every block adds to, once B1 has reported it.
 *
 * @param {JourneyContext} ctx
 */
export function timingsOf(ctx) {
  if (ctx.timings === undefined) throw new JourneyFailure('B1 has not reported its timings');
  return ctx.timings;
}

/**
 * `npm run dev` until it is ready, signed in and has printed the widget line, in the same origin.
 *
 * @param {JourneyContext} ctx
 * @param {(name: string, step: () => Promise<void>) => Promise<void>} timed
 * @param {() => number} stepTimeout
 */
async function timedDevStep(ctx, timed, stepTimeout) {
  /** @type {{ ready: string, widget: string } | undefined} */
  let lines;
  await timed('npm run dev', async () => {
    const dev = startDev(ctx.machine, DEMO_IN, ctx.anthropic);
    ctx.devs.push(dev);
    lines = await dev.untilWidget(stepTimeout());
    if (!dev.state.modelConnection) {
      throw new JourneyFailure('aw dev printed no "model connection: default (anthropic)" line');
    }
  });
  if (lines === undefined) throw new JourneyFailure('npm run dev reported no lines');
  const baseUrl = new URL(lines.ready).origin;
  if (new URL(lines.widget).origin !== baseUrl) {
    throw new JourneyFailure(`the widget line names another origin than ${baseUrl}`);
  }
  return baseUrl;
}

/**
 * B1's record: said, summarised, written to `journey-timings.json` and checked against the budget.
 *
 * @param {JourneyContext} ctx @param {import('./run-timing.mjs').JourneyProgress} progress
 * @param {number} wallSeconds @param {number} firstToken
 */
function reportFirstJourney(ctx, progress, wallSeconds, firstToken) {
  const report = timingsReport({ steps: progress.steps, wallSeconds });
  for (const step of report.steps) say(`journey: ${step.name} ${String(step.seconds)} s`);
  say(`journey: sum of the steps ${String(report.stepsSeconds)} s`);
  say(totalLine(report));
  /** @type {import('./run-timing.mjs').JourneyTimings} */
  const timings = {
    file: path.join(ctx.work, 'journey-timings.json'),
    model: ctx.live ? 'live' : 'fake',
    b1: report,
    firstTokenSeconds: {},
    budgets: {},
  };
  ctx.timings = timings;
  appendSummary(stepSummaryMarkdown(report));
  recordFirstToken(timings, 'b1', firstToken);
  writeTimings(timings);
  progress.reported = true;
  assertWithinBudget(report);
}

/**
 * B1: `npm create`, `npm install`, `npm run dev` and the widget, each step timed and the whole on
 * the wall clock.
 *
 * @param {JourneyContext} ctx
 * @returns {Promise<{ baseUrl: string, created: Record<string, string> }>}
 */
export async function runFirstJourney(ctx) {
  const { machine } = ctx;
  const progress = newProgress();
  const started = progress.started;
  /** Each timed step may use what is left of the budget, plus a minute to report it. */
  const stepTimeout = () =>
    Math.max(30_000, JOURNEY_BUDGET_SECONDS * 1000 - (performance.now() - started) + 60_000);
  ctx.timing = progress;
  /** @param {string} name @param {() => Promise<void>} step */
  const timed = (name, step) => timedStep(progress, name, step);

  await timed(
    `npm create @indx-workspace@latest demo (brand colour ${JOURNEY_BRAND_COLOUR})`,
    async () => {
      await execAnswering(machine, `npm create ${CREATE_PACKAGE} demo`, {
        workdir: WORK_IN,
        timeoutMs: stepTimeout(),
        answers: { [promptOf('embedder.brandColour')]: JOURNEY_BRAND_COLOUR },
      });
    },
  );
  // Inside the wall clock: the budget covers the harness's work between the steps too.
  const created = await snapshotDemo(machine, stepTimeout());

  await timed('npm install', async () => {
    await execOk(machine, ['npm', 'install'], { workdir: DEMO_IN, timeoutMs: stepTimeout() });
  });
  const baseUrl = await timedDevStep(ctx, timed, stepTimeout);

  const firstNonce = nonce();
  let firstToken = 0;
  await timed('widget answers', async () => {
    firstToken = await widgetTest(machine, {
      baseUrl,
      nonce: firstNonce,
      timeoutMs: stepTimeout(),
      live: ctx.live,
    });
    if (!ctx.live) assertReplyRecorded(ctx.requests, firstNonce, ctx.fakeKey);
  });
  const wallSeconds = (performance.now() - started) / 1000;
  reportFirstJourney(ctx, progress, wallSeconds, firstToken);
  return { baseUrl, created };
}

/**
 * The untimed checks after B1, under a checks cap: `demo/` unchanged, the engine refusal, the
 * Viewer key, the allowed origins, promote and rollback, feedback, the pinned version and (fake
 * model only) a run that reads a granted file.
 *
 * @param {JourneyContext} ctx @param {string} baseUrl @param {Record<string, string>} created
 */
export async function runUntimedChecks(ctx, baseUrl, created) {
  const { machine } = ctx;
  const limit = checksLimit(Date.now() + ctx.checksMs);
  assertUnchanged('demo', created, await snapshotDemo(machine, limit(120_000)));
  say('journey: demo/ unchanged after create (runtime-owned paths excluded)');

  const agent = await agentFile(machine, limit);
  const email = ctx.devs[0]?.state.adminEmail ?? null;
  await checkMcpOnPi(machine, agent, limit);
  await checkViewerForbidden(machine, baseUrl, email, limit);
  await checkAllowedOrigins(machine, baseUrl, limit);
  await checkPromoteRollback(machine, limit);
  await checkFeedbackFails(machine, baseUrl, limit);
  await checkPinnedVersion(machine, baseUrl, limit);
  // The fake answers e2e-files-<nonce> with a Read and a Write; a live model does not.
  if (!ctx.live) {
    const { evidence, toolRequests, bodies } = ctx;
    await checkRunFiles(machine, { baseUrl, email, limit, evidence, toolRequests, bodies });
  }
  return { agent, limit };
}

/**
 * Stop the first `aw dev` and start it again without `ANTHROPIC_*`: it must keep the versions and
 * answer through the persisted model connection with the original key.
 *
 * @param {JourneyContext} ctx @param {{ file: string, source: string }} agent
 * @param {(capMs: number) => number} limit
 */
export async function runRestartCheck(ctx, agent, limit) {
  const { machine } = ctx;
  const agentList = await execOk(machine, ['npx', 'aw', 'agents', 'list', '--json'], {
    workdir: DEMO_IN,
    timeoutMs: limit(120_000),
    quiet: true,
  });
  const agentId = agentIdOf(agentList.stdout, agentNameOfSource(agent.source));
  const versionsBefore = await versionsOf(machine, agentId, limit);
  const first = ctx.devs[0];
  if (first === undefined) throw new JourneyFailure('no npm run dev to stop');
  await first.stop(limit);

  const second = startDev(machine, DEMO_IN, {});
  ctx.devs.push(second);
  const again = await second.untilWidget(limit(180_000));
  if (second.state.modelConnection) {
    throw new JourneyFailure('the restart created the model connection again: it did not persist');
  }
  if ((await versionsOf(machine, agentId, limit)) !== versionsBefore) {
    throw new JourneyFailure('the agent versions changed across the restart');
  }
  const secondNonce = nonce();
  await widgetTest(machine, {
    baseUrl: new URL(again.ready).origin,
    nonce: secondNonce,
    timeoutMs: limit(240_000),
    live: ctx.live,
  });
  // The original key: the persisted connection's secret still decrypts after the restart.
  if (!ctx.live) assertReplyRecorded(ctx.requests, secondNonce, ctx.fakeKey);
  say(
    'journey: after a restart without ANTHROPIC_*, the same versions answer with the persisted key',
  );
  return { second, again };
}
