import { failureOf, ROOT } from './harness-fixtures.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { describe, expect, it } from 'vitest';
import {
  JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  JOURNEY_TOOL_BUDGET_SECONDS,
  JOURNEY_PORTAL_BUDGET_SECONDS,
  CONSOLE_FEATURE_ENTRIES,
  JOURNEY_FEATURE_IDS,
  consoleEntriesFor,
  JourneyFailure,
  assertWithinBudget,
  stepSummaryMarkdown,
  timingsReport,
  totalLine,
  unfinishedSummaryMarkdown,
  unfinishedTimingsReport,
} from './harness.mjs';
import { PORTAL_CREATE_ARGS, PORTAL_FEATURES } from './run.mjs';

const block = (seconds: number) => [{ name: 'the launcher shows the colour', seconds }];

it('passes B2 at 60.0 s and fails at 60.04 s (recorded 60.1 s), naming the slowest step', () => {
  const atBudget = timingsReport(
    { steps: block(60), wallSeconds: 60 },
    JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  );
  expect(atBudget.budgetSeconds).toBe(60);
  expect(() => assertWithinBudget(atBudget, JOURNEY_LOOK_CHANGE_BUDGET_SECONDS)).not.toThrow();
  const over = timingsReport(
    { steps: block(60.04), wallSeconds: 60.04 },
    JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  );
  expect(over.totalSeconds).toBe(60.1);
  expect(over.withinBudget).toBe(false);
  expect(
    failureOf(() => assertWithinBudget(over, JOURNEY_LOOK_CHANGE_BUDGET_SECONDS)).message,
  ).toBe(
    'the journey took 60.1 s, over the 60 s budget; the slowest step was the launcher shows the colour (60 s)',
  );
});

it('passes B3 at 900 s and fails at 900.1 s', () => {
  const at = timingsReport({ steps: block(900), wallSeconds: 900 }, JOURNEY_TOOL_BUDGET_SECONDS);
  expect(() => assertWithinBudget(at, JOURNEY_TOOL_BUDGET_SECONDS)).not.toThrow();
  const over = timingsReport(
    { steps: block(900.1), wallSeconds: 900.1 },
    JOURNEY_TOOL_BUDGET_SECONDS,
  );
  expect(() => assertWithinBudget(over, JOURNEY_TOOL_BUDGET_SECONDS)).toThrow(JourneyFailure);
});

it('refuses any budget that is not declared, so no option can raise one', () => {
  expect(JOURNEY_LOOK_CHANGE_BUDGET_SECONDS).toBe(60);
  expect(JOURNEY_TOOL_BUDGET_SECONDS).toBe(900);
  const unsafe: unknown = 601;
  expect(
    failureOf(() =>
      timingsReport(
        { steps: block(1), wallSeconds: 1 },
        unsafe as Parameters<typeof timingsReport>[1],
      ),
    ).message,
  ).toBe('601 s is not a journey budget; the budgets are 600, 60, 900 s');
  const report = timingsReport(
    { steps: block(1), wallSeconds: 1 },
    JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  );
  const wider: unknown = 61;
  expect(
    failureOf(() => assertWithinBudget(report, wider as Parameters<typeof assertWithinBudget>[1]))
      .message,
  ).toBe('61 s is not a journey budget; the budgets are 600, 60, 900 s');
  const forged: unknown = { ...report, budgetSeconds: 6000 };
  expect(() => totalLine(forged as typeof report)).toThrow(JourneyFailure);
});

it('labels each block in its total line and summary', () => {
  const report = timingsReport(
    { steps: block(12.3), wallSeconds: 12.3 },
    JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  );
  expect(totalLine(report, 'B2 look change')).toBe('journey: B2 look change 12.3 s (budget 60 s)');
  expect(stepSummaryMarkdown(report, 'B2 look change')).toContain(
    '### B2 look change (budget 60 s)',
  );
  const unfinished = unfinishedTimingsReport(
    { steps: [], failed: { name: 'tool answer', seconds: 3 }, elapsedSeconds: 3 },
    JOURNEY_TOOL_BUDGET_SECONDS,
  );
  expect(unfinished.budgetSeconds).toBe(900);
  expect(unfinishedSummaryMarkdown(unfinished, 'B3b openapi tool by hand')).toContain(
    '### B3b openapi tool by hand (budget 900 s): failed',
  );
});

describe('J1 (issue #1510): the portal budget', () => {
  const block = (seconds: number) => [{ name: 'the portal signs in', seconds }];

  it('is 600 s, a declared budget of its own', () => {
    expect(JOURNEY_PORTAL_BUDGET_SECONDS).toBe(600);
    const at = timingsReport(
      { steps: block(600), wallSeconds: 600 },
      JOURNEY_PORTAL_BUDGET_SECONDS,
    );
    expect(at).toMatchObject({ budgetSeconds: 600, finished: true, totalSeconds: 600 });
    expect(at.withinBudget).toBe(true);
    expect(() => assertWithinBudget(at, JOURNEY_PORTAL_BUDGET_SECONDS)).not.toThrow();
    expect(totalLine(at, 'J1 portal')).toBe('journey: J1 portal 600 s (budget 600 s)');
  });

  it('fails at 600.04 s (recorded 600.1 s), naming the slowest step', () => {
    const over = timingsReport(
      { steps: block(600.04), wallSeconds: 600.04 },
      JOURNEY_PORTAL_BUDGET_SECONDS,
    );
    expect(over.totalSeconds).toBe(600.1);
    expect(over.withinBudget).toBe(false);
    expect(failureOf(() => assertWithinBudget(over, JOURNEY_PORTAL_BUDGET_SECONDS)).message).toBe(
      'the journey took 600.1 s, over the 600 s budget; the slowest step was the portal signs in (600 s)',
    );
  });

  it('records an unfinished run as finished: false, with no budget verdict', () => {
    const unfinished = unfinishedTimingsReport(
      { steps: block(40), failed: { name: 'npm run dev', seconds: 5 }, elapsedSeconds: 46 },
      JOURNEY_PORTAL_BUDGET_SECONDS,
    );
    expect(unfinished).toMatchObject({ budgetSeconds: 600, finished: false, elapsedSeconds: 46 });
    expect(unfinished).not.toHaveProperty('withinBudget');
  });

  it('leaves the refusal of an undeclared budget as it was', () => {
    const unsafe: unknown = 601;
    expect(
      failureOf(() =>
        timingsReport(
          { steps: block(1), wallSeconds: 1 },
          unsafe as Parameters<typeof timingsReport>[1],
        ),
      ).message,
    ).toBe('601 s is not a journey budget; the budgets are 600, 60, 900 s');
  });

  it('times the documented portal command, with the chosen features', () => {
    const docs = readFileSync(path.join(ROOT, 'docs/sdk/site/building/portal.mdx'), 'utf8');
    expect(docs).toContain('npm create @indx-workspace@latest portal -- --template portal --yes');
    expect(PORTAL_CREATE_ARGS.slice(0, 4)).toEqual(['portal', '--', '--template', 'portal']);
    expect(PORTAL_CREATE_ARGS.at(-1)).toBe('--yes');
    expect(PORTAL_CREATE_ARGS).toContain(PORTAL_FEATURES.join(','));
    expect(PORTAL_FEATURES).toEqual(['chat', 'files', 'connectors']);
  });
});

describe('J1 (issue #1510): the console shows only the chosen features', () => {
  it('splits the sidebar entries into the chosen and the left out', () => {
    expect(consoleEntriesFor(PORTAL_FEATURES)).toEqual({
      shown: ['New chat', 'Files', 'Connectors'],
      hidden: ['Projects', 'Skills', 'Runs', 'Shared links'],
    });
    // A feature with no sidebar entry hides none and shows none.
    expect(consoleEntriesFor(['chat', 'surfaces']).shown).toEqual(['New chat']);
  });

  it('refuses an empty, repeated or unknown feature', () => {
    expect(failureOf(() => consoleEntriesFor([])).message).toBe('no feature was chosen');
    expect(failureOf(() => consoleEntriesFor(['chat', 'chat'])).message).toBe(
      'a feature is chosen twice: chat,chat',
    );
    expect(failureOf(() => consoleEntriesFor(['wiki'])).message).toBe('wiki is not a feature');
  });

  it('agrees with the contracts and with the console navigation', () => {
    expect(JOURNEY_FEATURE_IDS).toEqual(FEATURE_IDS);
    const navigation = readFileSync(
      path.join(ROOT, 'apps/web/components/shell/navigation.ts'),
      'utf8',
    );
    const entries: Record<string, string> = {};
    for (const [, label, feature] of navigation.matchAll(
      /label: '([^']+)',\s*icon: '[^']+',\s*feature: '(\w+)'/gu,
    )) {
      if (label !== undefined && feature !== undefined && feature !== 'core') {
        entries[feature] = label;
      }
    }
    expect(entries).toEqual(CONSOLE_FEATURE_ENTRIES);
  });
});
