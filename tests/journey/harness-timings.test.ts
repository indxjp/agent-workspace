import { failureOf } from './harness-fixtures.js';
import { expect, it } from 'vitest';
import {
  JOURNEY_BUDGET_SECONDS,
  JourneyFailure,
  assertWithinBudget,
  stepSummaryMarkdown,
  timingsReport,
  totalLine,
  unfinishedJourneyRecord,
  unfinishedSummaryMarkdown,
  unfinishedTimingsReport,
} from './harness.mjs';

const steps = [
  { name: 'npm create @indx-workspace@latest demo -- --yes', seconds: 12.34 },
  { name: 'npm install', seconds: 101.25 },
  { name: 'npm run dev', seconds: 40.04 },
  { name: 'widget answers', seconds: 9.9 },
];

it('checks the wall clock, harness work included, against the fixed 600 s budget', () => {
  const report = timingsReport({ steps, wallSeconds: 165.02 });
  expect(report).toEqual({
    budgetSeconds: 600,
    finished: true,
    totalSeconds: 165.1,
    stepsSeconds: 163.5,
    withinBudget: true,
    steps: [
      { name: 'npm create @indx-workspace@latest demo -- --yes', seconds: 12.3 },
      { name: 'npm install', seconds: 101.3 },
      { name: 'npm run dev', seconds: 40 },
      { name: 'widget answers', seconds: 9.9 },
    ],
  });
  expect(totalLine(report)).toBe('journey: total 165.1 s (budget 600 s)');
  expect(stepSummaryMarkdown(report)).toContain('| npm install | 101.3 |');
  expect(stepSummaryMarkdown(report)).toContain('| Sum of the steps | 163.5 |');
  expect(stepSummaryMarkdown(report)).toContain('| **Total (wall clock)** | **165.1** |');
  expect(() => assertWithinBudget(report)).not.toThrow();
});

it('fails at 601 s, naming the slowest step', () => {
  const report = timingsReport({
    steps: [
      { name: 'npm create @indx-workspace@latest demo -- --yes', seconds: 20 },
      { name: 'npm install', seconds: 400 },
      { name: 'npm run dev', seconds: 150 },
      { name: 'widget answers', seconds: 31 },
    ],
    wallSeconds: 601,
  });
  expect(report.withinBudget).toBe(false);
  expect(stepSummaryMarkdown(report)).toContain('Over budget.');
  expect(failureOf(() => assertWithinBudget(report)).message).toBe(
    'the journey took 601 s, over the 600 s budget; the slowest step was npm install (400 s)',
  );
});

it('fails when the steps fit but the harness work between them pushes the wall clock over', () => {
  const report = timingsReport({
    steps: [{ name: 'npm install', seconds: 590 }],
    wallSeconds: 600.5,
  });
  expect(report.stepsSeconds).toBe(590);
  expect(report.withinBudget).toBe(false);
  expect(() => assertWithinBudget(report)).toThrow(JourneyFailure);
});

it('regression: 600.04 s is over the budget in the record, the summary and the check alike', () => {
  const report = timingsReport({
    steps: [{ name: 'npm install', seconds: 600.04 }],
    wallSeconds: 600.04,
  });
  expect(report.totalSeconds).toBe(600.1);
  expect(report.withinBudget).toBe(false);
  expect(stepSummaryMarkdown(report)).toContain('Over budget.');
  expect(stepSummaryMarkdown(report)).not.toContain('Within budget.');
  expect(failureOf(() => assertWithinBudget(report)).message).toContain('took 600.1 s');
});

it('keeps exactly 600 s within the budget', () => {
  const report = timingsReport({
    steps: [{ name: 'npm install', seconds: 600 }],
    wallSeconds: 600,
  });
  expect(report.totalSeconds).toBe(600);
  expect(report.withinBudget).toBe(true);
  expect(() => assertWithinBudget(report)).not.toThrow();
});

it('refuses a wall clock shorter than the steps it contains', () => {
  expect(failureOf(() => timingsReport({ steps, wallSeconds: 100 })).message).toBe(
    'the wall-clock time is shorter than the sum of the steps',
  );
  expect(failureOf(() => timingsReport({ steps, wallSeconds: Number.NaN })).message).toBe(
    'the wall-clock time is shorter than the sum of the steps',
  );
});

it('regression (run 36975818149): a run that fails inside a step still records what it measured', () => {
  const report = unfinishedTimingsReport({
    steps: [
      { name: 'npm create @indx-workspace@latest demo (brand colour #c0392b)', seconds: 2.74 },
      { name: 'npm install', seconds: 32.52 },
    ],
    failed: { name: 'npm run dev', seconds: 4.09 },
    elapsedSeconds: 39.51,
  });
  expect(report).toEqual({
    budgetSeconds: 600,
    finished: false,
    elapsedSeconds: 39.6,
    failedStep: { name: 'npm run dev', seconds: 4.1 },
    steps: [
      { name: 'npm create @indx-workspace@latest demo (brand colour #c0392b)', seconds: 2.7 },
      { name: 'npm install', seconds: 32.5 },
    ],
  });
  const markdown = unfinishedSummaryMarkdown(report);
  expect(markdown).toContain('| npm install | 32.5 |');
  expect(markdown).toContain('| npm run dev (failed) | 4.1 |');
  expect(markdown).toContain('| **Wall clock until the failure** | **39.6** |');
  expect(markdown).not.toContain('Within budget.');
  expect(unfinishedJourneyRecord(report, 'live')).toEqual({ ...report, model: 'live' });
  expect(unfinishedJourneyRecord(report, 'fake').model).toBe('fake');
});

it('refuses an unfinished record whose wall clock is shorter than its steps', () => {
  expect(
    failureOf(() =>
      unfinishedTimingsReport({
        steps: [{ name: 'npm install', seconds: 30 }],
        failed: { name: 'npm run dev', seconds: 5 },
        elapsedSeconds: 20,
      }),
    ).message,
  ).toBe('the wall-clock time is shorter than the sum of the steps');
  expect(
    failureOf(() =>
      unfinishedTimingsReport({
        steps: [],
        failed: { name: 'npm run dev', seconds: Number.NaN },
        elapsedSeconds: 20,
      }),
    ).message,
  ).toBe('step npm run dev has no valid duration');
});

it('cannot be given a larger budget', () => {
  expect(JOURNEY_BUDGET_SECONDS).toBe(600);
  const widened: unknown = { steps, wallSeconds: 200, budget: 6000 };
  expect(
    failureOf(() => timingsReport(widened as Parameters<typeof timingsReport>[0])).message,
  ).toBe('timingsReport takes only steps and wallSeconds; the budget is fixed at 600 s');
});

it('refuses a step without a valid duration', () => {
  expect(
    failureOf(() =>
      timingsReport({ steps: [{ name: 'npm install', seconds: Number.NaN }], wallSeconds: 1 }),
    ).message,
  ).toBe('step npm install has no valid duration');
  expect(failureOf(() => timingsReport({ steps: [], wallSeconds: 1 })).message).toBe(
    'the journey measured no step',
  );
});
