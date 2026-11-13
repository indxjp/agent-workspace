import { expect, it } from 'vitest';
import { createAnswerFor } from './harness.mjs';

const ESC = '\u001b';
const COLOUR = '#c0392b';
const ANSWERS = { 'What is your brand colour?': COLOUR };

it('answers npm, every setup question and the file list', () => {
  expect(
    createAnswerFor('Need to install the following packages:\nOk to proceed? (y) ', ANSWERS),
  ).toBe('y');
  expect(
    createAnswerFor(
      `${ESC}[1G${ESC}[0JWhere should agents run their tools? (auto | docker | local) [auto] ${ESC}[63G`,
      ANSWERS,
    ),
  ).toBe('');
  expect(
    createAnswerFor(
      'What is your first agent called? (lower-case letters, digits and hyphens, 1-64 characters, no hyphen at either end) [assistant] ',
      ANSWERS,
    ),
  ).toBe('');
  expect(
    createAnswerFor(
      '\r\nWhat is your brand colour? (a hex colour, # followed by six hex digits) [#2f5fd0] ',
      ANSWERS,
    ),
  ).toBe(COLOUR);
  expect(
    createAnswerFor(
      'create will write:\r\n  surfaces/main.ts\r\nwrite these 9 files into /home/pwuser/work/demo? [y/N] ',
      ANSWERS,
    ),
  ).toBe('y');
});

it('presses Enter on a whole select menu, as CI printed it, and waits for a partial one', () => {
  const spinner = `⠼${ESC}[1G${ESC}[0K`;
  const menu =
    `${ESC}[36m?${ESC}[39m ${ESC}[1mWhich theme should setup start from?${ESC}[22m ${ESC}[2m(up/down move, enter accepts)${ESC}[22m\n` +
    `${ESC}[36m>${ESC}[39m ${ESC}[36m(*) support ${ESC}[39m${ESC}[32m (recommended)${ESC}[39m\n` +
    `  ( ) copilot   ${ESC}[32m              ${ESC}[39m${ESC}[2m  Drafts${ESC}[22m\n`;
  expect(createAnswerFor(`${spinner}${menu}`, ANSWERS)).toBe('');
  // Only the title and one row so far, or a row still being written: keep waiting.
  expect(createAnswerFor(menu.split('\n').slice(0, 2).join('\n') + '\n', ANSWERS)).toBeNull();
  expect(createAnswerFor(menu.slice(0, -1), ANSWERS)).toBeNull();
  const confirm =
    '? Write these 9 files into /home/pwuser/work/demo? (up/down move, enter accepts)\n' +
    '> (*) yes (recommended)\n  ( ) no\n';
  expect(createAnswerFor(confirm, ANSWERS)).toBe('');
  // A narrow terminal adds the cursor's whole summary below the rows (BH061-053).
  const summarised = `${menu}  ${ESC}[2mAnswers customer questions and hands over to a person${ESC}[22m
`;
  expect(createAnswerFor(summarised, ANSWERS)).toBe('');
  // create's install and start offers are declined: the journey does both itself.
  for (const title of ['Install dependencies now?', 'Start it now?']) {
    const offer = `? ${title} (up/down move, enter accepts)
> (*) yes (recommended)
  ( ) no
`;
    expect(createAnswerFor(offer, ANSWERS)).toBe('j');
  }
  // The collapsed answer line a finished menu leaves is not a menu.
  expect(createAnswerFor('v Which theme should setup start from? support\n', ANSWERS)).toBeNull();
});

it('drives a menu to the scripted answer, never a bare Enter, and Enter only for defaults', () => {
  const multi =
    '? Which internal tools should the agent call? (up/down move, space toggles (up to 2), enter accepts)\n' +
    '  [ ] openapi\n  [ ] postgres\n> [x] none (recommended)\n';
  const scripted = { 'Which internal tools should the agent call?': 'openapi' };
  // Pass 1 clears nothing wanted-off but `none` (cursor starts on it), pass 2 adds openapi.
  const keys = createAnswerFor(multi, scripted);
  expect(keys).not.toBe('');
  // Replay the keys against the reducer's rules: j moves down with wrap, space toggles.
  let cursor = 2;
  const on = new Set(['none']);
  for (const key of keys ?? '') {
    if (key === 'j') cursor = (cursor + 1) % 3;
    else {
      const value = ['openapi', 'postgres', 'none'][cursor] ?? '';
      if (on.has(value)) on.delete(value);
      else {
        if (value === 'none') on.clear();
        else on.delete('none');
        on.add(value);
      }
    }
  }
  expect([...on]).toStrictEqual(['openapi']);
  // Not named in `answers`: Enter takes the recommendation.
  expect(createAnswerFor(multi, ANSWERS)).toBe('');

  const single =
    '? Which theme should setup start from? (up/down move, enter accepts)\n' +
    '> (*) support (recommended)\n  ( ) copilot\n  ( ) knowledge\n';
  expect(createAnswerFor(single, { 'Which theme should setup start from?': 'knowledge' })).toBe(
    'jj',
  );
  expect(createAnswerFor(single, { 'Which theme should setup start from?': 'support' })).toBe('');
  expect(() => createAnswerFor(single, { 'Which theme should setup start from?': 'nope' })).toThrow(
    /no option nope/u,
  );
});

it('answers a menu once: its repaints, whole or split across chunks, are not questions', () => {
  const scripted = { 'Which theme should setup start from?': 'knowledge' };
  const title = '? Which theme should setup start from? (up/down move, enter accepts)\n';
  const first = `${title}> (*) support (recommended)\n  ( ) copilot\n  ( ) knowledge\n`;
  expect(createAnswerFor(first, scripted)).toBe('jj');
  // After our `j` the menu climbs back over its frame, erases it and draws it again.
  const repaint = `${ESC}[4A${ESC}[J${title}  ( ) support (recommended)\n> (*) copilot\n  ( ) knowledge\n`;
  expect(createAnswerFor(repaint, scripted)).toBeNull();
  // Cursor already on the scripted answer, still a repaint: no second Enter.
  const arrived = `${ESC}[4A${ESC}[J${title}  ( ) support\n  ( ) copilot\n> (*) knowledge\n`;
  expect(createAnswerFor(arrived, scripted)).toBeNull();
  // Chunks as the pty may deliver them: no prefix of the repaint is ever answered.
  for (let end = 0; end <= repaint.length; end += 1) {
    expect(createAnswerFor(repaint.slice(0, end), scripted), String(end)).toBeNull();
  }
  // A later question's first frame, after the collapsed answer line, is answered again.
  const collapsed = `${ESC}[4A${ESC}[Jv Which theme should setup start from? knowledge\n`;
  const next = '? Which tools? (up/down move, enter accepts)\n> (*) a (recommended)\n  ( ) b\n';
  expect(createAnswerFor(`${repaint}${collapsed}${next}`, scripted)).toBe('');
});

it("answers a setup question drawn over npm exec's spinner, as CI printed it (run 36974429681)", () => {
  const spinner = ['⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇']
    .map((glyph) => `${glyph}${ESC}[1G${ESC}[0K`)
    .join('');
  const screen =
    `\r\n${spinner}\r\n> npx\r\n> 'create-indx-workspace' demo\r\n\r\n` +
    `⠇${ESC}[1G${ESC}[0K${ESC}[1G${ESC}[0JWhere should agents run their tools? ` +
    `(auto | sandbox-runtime | local) [auto] ${ESC}[78G`;
  expect(createAnswerFor(screen, ANSWERS)).toBe('');
  expect(
    createAnswerFor(
      `⠇${ESC}[1G${ESC}[0K${ESC}[1G${ESC}[0JWhat is your brand colour? (a hex colour, # followed by six hex digits) [#2f5fd0] ${ESC}[90G`,
      ANSWERS,
    ),
  ).toBe(COLOUR);
});

it('keeps text a cursor move to another column did not overwrite', () => {
  expect(
    createAnswerFor(
      `⠇${ESC}[78GWhere should agents run their tools? (auto | sandbox-runtime | local) [auto] `,
      ANSWERS,
    ),
  ).toBeNull();
});

it('waits while the program is not at a prompt', () => {
  for (const screen of [
    '',
    'npm warn exec The following package was not found\r\n',
    'What is your brand colour? (a hex colour, # followed by six hex digits) [#2f5fd0] \r\n',
    'What is your brand colour? (a hex colour',
    '#c0392b\r\n',
  ]) {
    expect(createAnswerFor(screen, ANSWERS)).toBeNull();
  }
});

it("answers B3a's multi-select and path questions from the answers map, by prompt text", () => {
  const answers = {
    'Which internal tools should the agent call?': 'openapi',
    'Where is the OpenAPI document?': 'apis/orders.openapi.json',
  };
  expect(
    createAnswerFor(
      'Which internal tools should the agent call? (openapi | postgres | none; comma-separated) [none] ',
      answers,
    ),
  ).toBe('openapi');
  expect(
    createAnswerFor(
      'Where is the OpenAPI document? (a project-relative path to a .json, .yaml or .yml file, or an https URL without a credential, up to 2048 characters) [openapi.json] ',
      answers,
    ),
  ).toBe('apis/orders.openapi.json');
  // A question the map does not name takes the recommended answer; an empty recommendation too.
  expect(
    createAnswerFor(
      'Which permissions should the agent have? (readFiles | writeFiles | runCommands | unrestrictedNetwork; comma-separated) [] ',
      answers,
    ),
  ).toBe('');
});
