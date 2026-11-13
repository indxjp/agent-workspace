/* global process, performance */

/** The fake model's reply text (run.mjs, stubExpectation); the live run leaves it unset and expects the nonce. */
export const STUB = process.env['JOURNEY_EXPECT_TEXT'];

/**
 * @typedef {{ id: string, name: string, targetSeconds?: number, pending?: string, seconds?: number }} Row
 * @type {Row[]}
 */
export const ROWS = [
  { id: 'T1', name: 'create (no TTY)' },
  { id: 'T2', name: 'npm install (cold)', targetSeconds: 30 },
  { id: 'T3', name: 'aw dev ready', targetSeconds: 15 },
  { id: 'T4', name: 'first answer · aw chat -p' },
  { id: 'T5', name: 'add code tool → answer uses it', targetSeconds: 5 },
  { id: 'T6', name: 'add skill → synced' },
  { id: 'T7', name: 'add connector in yaml → applied' },
  { id: 'T8', name: 'aw eval add, then aw eval' },
  {
    id: 'T9',
    name: '<Chat/> in a Vite app answers',
    pending:
      'FH-12 (#699) landed; needs a Vite install, a browser page and an allowedOrigins entry in this harness',
  },
];

/** @param {string} id */
export const row = (id) => {
  const found = ROWS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};

/** @param {number} from */
export const seconds = (from) => (performance.now() - from) / 1000;
