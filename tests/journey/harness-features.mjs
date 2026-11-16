import { JourneyFailure } from './harness-failure.mjs';

/**
 * The switchable features (ADR-0160 D1), as `@indx-workspace/contracts/features` lists them; kept
 * here because this file runs where nothing of the repository is installed (`harness.test.ts`
 * checks the two lists agree).
 */
export const JOURNEY_FEATURE_IDS = Object.freeze([
  'chat',
  'projects',
  'files',
  'skills',
  'connectors',
  'runs',
  'sharing',
  'surfaces',
  'triggers',
  'evaluations',
  'builder',
]);

/**
 * The console sidebar's entry of each feature that has one (`apps/web/components/shell/
 * navigation.ts`; `harness.test.ts` checks they agree). The other features have no entry.
 */
export const CONSOLE_FEATURE_ENTRIES = Object.freeze({
  chat: 'New chat',
  projects: 'Projects',
  files: 'Files',
  skills: 'Skills',
  connectors: 'Connectors',
  runs: 'Runs',
  sharing: 'Shared links',
});

/**
 * The console sidebar entries a deployment installing `features` shows, and those it must not
 * (ADR-0160 D8), each in {@link CONSOLE_FEATURE_ENTRIES} order. An unknown or repeated feature, or
 * an empty list, is refused.
 *
 * @param {readonly string[]} features
 */
export function consoleEntriesFor(features) {
  if (features.length === 0) throw new JourneyFailure('no feature was chosen');
  if (new Set(features).size !== features.length) {
    throw new JourneyFailure(`a feature is chosen twice: ${features.join(',')}`);
  }
  for (const feature of features) {
    if (!JOURNEY_FEATURE_IDS.includes(feature)) {
      throw new JourneyFailure(`${feature} is not a feature`);
    }
  }
  /** @type {string[]} */
  const shown = [];
  /** @type {string[]} */
  const hidden = [];
  for (const [feature, label] of Object.entries(CONSOLE_FEATURE_ENTRIES)) {
    (features.includes(feature) ? shown : hidden).push(label);
  }
  return { shown, hidden };
}
