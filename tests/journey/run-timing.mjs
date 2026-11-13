/**
 * The journey's clocks: timed steps and blocks, and `journey-timings.json` with its job summary,
 * finished or not.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  JOURNEY_BUDGET_SECONDS,
  assertWithinBudget,
  stepSummaryMarkdown,
  timingsReport,
  totalLine,
  unfinishedJourneyRecord,
  unfinishedSummaryMarkdown,
  unfinishedTimingsReport,
} from './harness.mjs';
import { appendSummary, say } from './run-support.mjs';

/**
 * @typedef {{
 *   started: number,
 *   steps: { name: string, seconds: number }[],
 *   current: { name: string, from: number } | null,
 *   reported: boolean,
 * }} JourneyProgress
 */

/**
 * `journey-timings.json`: B1's record at the top level, as slice 1 wrote it (the manifest reads
 * it there), and S2-08's blocks under `budgets`, finished or not. Issue #609 adds which `model`
 * answered (`fake` or `live`) and each widget answer's first-token latency in seconds
 * (`firstTokenSeconds.b1`, `.toolByHand`, `.toolFromSetup`).
 *
 * @typedef {{ file: string, model: 'fake' | 'live', b1: TimingsReport, firstTokenSeconds: Record<string, number>, budgets: Record<string, TimingsReport | UnfinishedTimingsReport> }} JourneyTimings
 * @typedef {import('./harness.mjs').TimingsReport} TimingsReport
 * @typedef {import('./harness.mjs').UnfinishedTimingsReport} UnfinishedTimingsReport
 */

/** @returns {JourneyProgress} */
export function newProgress() {
  return { started: performance.now(), steps: [], current: null, reported: false };
}

/**
 * The record of a run that failed inside the timed part: the steps that finished, the one that
 * failed (or the harness work between two steps) and the wall clock until the failure, written
 * where the finished record goes, so the timings the workflow keeps always exist. It never throws,
 * so the failure it records stays the one the run reports.
 *
 * @param {string} work @param {JourneyProgress} timing @param {'fake' | 'live'} model
 */
export function writeUnfinishedTimings(work, timing, model) {
  try {
    const report = unfinishedOf(timing, JOURNEY_BUDGET_SECONDS);
    const record = unfinishedJourneyRecord(report, model);
    writeFileSync(path.join(work, 'journey-timings.json'), `${JSON.stringify(record, null, 2)}\n`);
    appendSummary(unfinishedSummaryMarkdown(report));
  } catch (error) {
    say(`journey: the unfinished timings were not written: ${String(error)}`);
  }
}

/**
 * The unfinished record of `timing` as of now, said on stdout.
 *
 * @param {JourneyProgress} timing @param {60 | 600 | 900} budgetSeconds
 */
function unfinishedOf(timing, budgetSeconds) {
  const now = performance.now();
  const failed =
    timing.current === null
      ? { name: 'harness work between the steps', seconds: 0 }
      : { name: timing.current.name, seconds: (now - timing.current.from) / 1000 };
  const report = unfinishedTimingsReport(
    { steps: timing.steps, failed, elapsedSeconds: (now - timing.started) / 1000 },
    budgetSeconds,
  );
  say(
    `journey: ${report.failedStep.name} failed after ${String(report.failedStep.seconds)} s ` +
      `(wall clock ${String(report.elapsedSeconds)} s)`,
  );
  return report;
}

/**
 * Runs one timed step of `progress`, recording its seconds and saying them.
 *
 * @param {JourneyProgress} progress @param {string} name @param {() => Promise<void>} step
 */
export async function timedStep(progress, name, step) {
  const from = performance.now();
  progress.current = { name, from };
  await step();
  const seconds = (performance.now() - from) / 1000;
  progress.current = null;
  progress.steps.push({ name, seconds });
  say(`journey: ${name} ${seconds.toFixed(1)} s`);
}

/** @param {JourneyTimings} timings */
export function writeTimings(timings) {
  const record = {
    ...timings.b1,
    model: timings.model,
    firstTokenSeconds: timings.firstTokenSeconds,
    budgets: timings.budgets,
  };
  writeFileSync(timings.file, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * One widget answer's first-token latency (Send to the agent's first text, as the visitor sees
 * it), kept under `firstTokenSeconds.<key>` and said.
 *
 * @param {JourneyTimings} timings @param {string} key @param {number} seconds
 */
export function recordFirstToken(timings, key, seconds) {
  timings.firstTokenSeconds[key] = seconds;
  say(`journey: first token (${key}) ${String(seconds)} s`);
  appendSummary(`First token (${key}, Send to the agent's first text): ${String(seconds)} s\n\n`);
}

/**
 * The record a failed block leaves under `budgets.<key>`; it never throws, so the block's own
 * failure stays the one the run reports.
 *
 * @param {JourneyTimings} timings @param {{ key: string, label: string, budgetSeconds: 60 | 600 | 900 }} block
 * @param {JourneyProgress} progress
 */
function writeUnfinishedBlock(timings, block, progress) {
  try {
    const report = unfinishedOf(progress, block.budgetSeconds);
    timings.budgets[block.key] = report;
    writeTimings(timings);
    appendSummary(unfinishedSummaryMarkdown(report, block.label));
  } catch (unwritten) {
    say(`journey: the ${block.label} timings were not written: ${String(unwritten)}`);
  }
}

/**
 * One timed block after B1 (B2, B3b, B3a, J1): its steps on the wall clock against its own budget.
 * `body` gets `step(name, run)` and `timeout()`, what is left of the budget plus a minute to
 * report it. The record is written under `budgets.<key>` whether the block passes or fails, then
 * the total line is said and checked against the budget.
 *
 * @param {JourneyTimings} timings
 * @param {{ key: string, label: string, budgetSeconds: 60 | 600 | 900 }} block
 * @param {(step: (name: string, run: () => Promise<void>) => Promise<void>, timeout: () => number) => Promise<void>} body
 */
export async function timedBlock(timings, block, body) {
  const progress = newProgress();
  const started = progress.started;
  const timeout = () =>
    Math.max(30_000, block.budgetSeconds * 1000 - (performance.now() - started) + 60_000);
  try {
    await body((name, run) => timedStep(progress, name, run), timeout);
  } catch (error) {
    writeUnfinishedBlock(timings, block, progress);
    throw error;
  }
  const report = timingsReport(
    { steps: progress.steps, wallSeconds: (performance.now() - started) / 1000 },
    block.budgetSeconds,
  );
  timings.budgets[block.key] = report;
  writeTimings(timings);
  appendSummary(stepSummaryMarkdown(report, block.label));
  say(totalLine(report, block.label));
  assertWithinBudget(report, block.budgetSeconds);
}
