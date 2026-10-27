import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { renderProjectFiles } from '@indx-workspace/sdk/project';
import { afterEach, describe, expect, it } from 'vitest';

import type { FakeRequestRecord } from '../generated-project/fake-anthropic.mjs';
import {
  DEFAULT_SURFACE_COLOUR,
  JOURNEY_BRAND_COLOUR,
  JOURNEY_BUDGET_SECONDS,
  JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  JOURNEY_TOOL_BUDGET_SECONDS,
  JourneyFailure,
  MIN_COMMAND_MS,
  SEALED_PATHS,
  TOOL_OWNED_PATHS,
  agentIdOf,
  agentNameOfSource,
  assertBrandColour,
  assertNoChatFailure,
  assertLauncherColour,
  assertReplyRecorded,
  assertSecretAbsent,
  assertServerRefusal,
  assertToolAnswer,
  assertToolCallSeen,
  assertToolOffered,
  assertUnchanged,
  assertWithinBudget,
  colourOfSurfaceSource,
  createAnswerFor,
  diffTrees,
  filesContaining,
  firstHourSummaryMarkdown,
  firstTokenOf,
  journeyMode,
  splitFirstHour,
  mcpAgentSource,
  devOrigin,
  parseDevLine,
  quickstartCommands,
  redact,
  registryOf,
  remainingMs,
  runOf,
  scrubbedEvidence,
  sessionTokenOf,
  snapshotTree,
  stepSummaryMarkdown,
  stringMapOf,
  stubExpectation,
  timingsReport,
  toolAgentSource,
  totalLine,
  unfinishedJourneyRecord,
  unfinishedSummaryMarkdown,
  unfinishedTimingsReport,
  withSurfaceColour,
  workDirectoryOf,
} from './harness.mjs';
import { PLAYWRIGHT_IMAGE, VERDACCIO_IMAGE } from './run.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HERE = import.meta.dirname;

/** What the renderer (`packages/sdk/src/project/render.ts`) writes for the surface. */
const SURFACE_SOURCE = [
  "import { defineSurface } from '@indx-workspace/sdk/define';",
  '',
  'export default defineSurface({',
  "  name: 'main',",
  "  agent: 'assistant',",
  "  title: 'Ask us',",
  '  theme: {',
  "    colour: '#2F5FD0',",
  '  },',
  '});',
  '',
].join('\n');

const AGENT_SOURCE = [
  "import { defineAgent } from '@indx-workspace/sdk/define';",
  '',
  'export default defineAgent({',
  "  name: 'assistant',",
  "  instructions: 'You are a helpful assistant.',",
  "  engine: 'claude-agent-sdk',",
  "  model: 'default',",
  '});',
  '',
].join('\n');

const KEY = 'sk-ant-e2e-fake-0123456789abcdef';
const NONCE = 'e2e-nonce-abc123';

function record(overrides: Partial<FakeRequestRecord>): FakeRequestRecord {
  return {
    at: '2026-10-02T00:00:00.000Z',
    method: 'POST',
    path: '/v1/messages',
    model: 'claude-sonnet-4-5',
    stream: true,
    reply: `Fake Anthropic reply to ${NONCE}: the generated project answered.`,
    apiKey: KEY,
    ...overrides,
  };
}

function failureOf(action: () => unknown): JourneyFailure {
  try {
    action();
  } catch (error) {
    if (error instanceof JourneyFailure) return error;
    throw error;
  }
  throw new Error('expected a JourneyFailure');
}

describe('the dev lines (C5, C6)', () => {
  it('reads ready, signed in, try, widget and model connection', () => {
    expect(parseDevLine('ready http://127.0.0.1:3000\r')).toEqual({
      kind: 'ready',
      url: 'http://127.0.0.1:3000',
    });
    expect(parseDevLine('signed in as admin@example.com (workspace default)')).toEqual({
      kind: 'signedIn',
    });
    expect(parseDevLine('try: http://127.0.0.1:3000/p/s/main/try')).toEqual({
      kind: 'try',
      url: 'http://127.0.0.1:3000/p/s/main/try',
    });
    expect(
      parseDevLine(
        'widget: <script src="http://127.0.0.1:3000/p/s/main/widget.js" async></script>',
      ),
    ).toEqual({ kind: 'widget', src: 'http://127.0.0.1:3000/p/s/main/widget.js' });
    expect(parseDevLine('model connection: default (anthropic)')).toEqual({
      kind: 'modelConnection',
    });
    expect(parseDevLine('synced: "assistant" created at version 1\r')).toEqual({ kind: 'synced' });
  });

  it('reads the try and embed rows of the ready screen', () => {
    expect(parseDevLine('  try       http://127.0.0.1:3000/p/s/main/try')).toEqual({
      kind: 'try',
      url: 'http://127.0.0.1:3000/p/s/main/try',
    });
    expect(
      parseDevLine(
        '  embed     <script src="http://127.0.0.1:3000/p/s/main/widget.js" async></script>',
      ),
    ).toEqual({ kind: 'widget', src: 'http://127.0.0.1:3000/p/s/main/widget.js' });
  });

  it('takes the ready origin from the ready, try or embed line', () => {
    const origin = 'http://127.0.0.1:3000';
    expect(devOrigin(parseDevLine(`ready ${origin}`))).toBe(origin);
    expect(devOrigin(parseDevLine(`  try       ${origin}/p/s/main/try`))).toBe(origin);
    expect(
      devOrigin(
        parseDevLine(`  embed     <script src="${origin}/p/s/main/widget.js" async></script>`),
      ),
    ).toBe(origin);
    expect(devOrigin(parseDevLine('  ✓ runtime   ready in 6.1 s   logs: x'))).toBeNull();
    expect(devOrigin(null)).toBeNull();
  });

  it('reads the bootstrap admin’s email from the ready screen’s console row', () => {
    expect(parseDevLine('            sign in as admin@localhost.test\r')).toEqual({
      kind: 'adminSignIn',
      email: 'admin@localhost.test',
    });
    // The password is never printed (BH061-011): the next row only names its file.
    expect(parseDevLine('            password in .agent-workspace/local-secrets.json')).toBeNull();
  });

  it('reads nothing from a line that is not one of them', () => {
    for (const line of [
      'ready',
      'ready ftp://127.0.0.1:3000',
      'signed in as admin@example.com',
      'widget: <script src="http://127.0.0.1:3000/p/s/main/widget.js"></script>',
      'try: http://127.0.0.1:3000/p/s/main',
      'model connection: other (anthropic)',
      // A later start names where the password is, never the password.
      'Sign in at http://127.0.0.1:3000 as admin@localhost.test; the password is in /x/local-secrets.json',
      'Sign in at http://127.0.0.1:3000 as admin@localhost.test; the password is BOOTSTRAP_ADMIN_PASSWORD, set in the environment or .env',
      'synced:',
      '',
    ]) {
      expect(parseDevLine(line)).toBeNull();
    }
  });
});

describe('the launcher colour', () => {
  it('takes theme.colour from the rendered surfaces/main.ts', () => {
    expect(colourOfSurfaceSource(SURFACE_SOURCE)).toBe('#2f5fd0');
  });

  it('fails when surfaces/main.ts names no colour', () => {
    expect(failureOf(() => colourOfSurfaceSource("export default { name: 'main' };")).message).toBe(
      'surfaces/main.ts names no theme colour (colour: #rrggbb)',
    );
  });

  it('accepts the same colour as rgb() or opaque rgba()', () => {
    expect(() => assertLauncherColour('#2f5fd0', 'rgb(47, 95, 208)')).not.toThrow();
    expect(() => assertLauncherColour('#2F5FD0', 'rgba(47, 95, 208, 1)')).not.toThrow();
  });

  it('fails on a wrong colour, naming both', () => {
    expect(failureOf(() => assertLauncherColour('#2f5fd0', 'rgb(0, 0, 0)')).message).toBe(
      "launcher colour rgb(0, 0, 0) is not surfaces/main.ts's #2f5fd0",
    );
    expect(
      failureOf(() => assertLauncherColour('#2f5fd0', 'rgba(47, 95, 208, 0.5)')).message,
    ).toContain('launcher colour rgba(47, 95, 208, 0.5)');
  });
});

describe('regression: the brand colour can tell the theme from the default', () => {
  it('names the widget default, which is also the question recommended answer', () => {
    const theme = readFileSync(path.join(ROOT, 'packages', 'react', 'src', 'theme.ts'), 'utf8');
    expect(theme).toMatch(new RegExp(`^ {2}colour: '${DEFAULT_SURFACE_COLOUR}',$`, 'mu'));
    const setup = readFileSync(path.join(ROOT, 'packages', 'contracts', 'src', 'setup.ts'), 'utf8');
    expect(setup).toContain(`recommended: '${DEFAULT_SURFACE_COLOUR}',`);
  });

  it('answers a brand colour that is not the default', () => {
    expect(JOURNEY_BRAND_COLOUR).toMatch(/^#[0-9a-f]{6}$/u);
    expect(JOURNEY_BRAND_COLOUR).not.toBe(DEFAULT_SURFACE_COLOUR);
    expect(() => assertBrandColour('#C0392B', JOURNEY_BRAND_COLOUR)).not.toThrow();
  });

  it('refuses the default colour, which the launcher shows without any theme', () => {
    expect(failureOf(() => assertBrandColour('#2f5fd0', '#2F5FD0')).message).toBe(
      "the brand colour #2F5FD0 is the widget's default, so the launcher cannot prove it",
    );
  });

  it('refuses a file that does not name the answered colour', () => {
    expect(failureOf(() => assertBrandColour('#2f5fd0', '#c0392b')).message).toBe(
      'surfaces/main.ts names #2f5fd0, not the answered brand colour #c0392b',
    );
  });
});

describe('answering npm create on a terminal', () => {
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
    expect(() =>
      createAnswerFor(single, { 'Which theme should setup start from?': 'nope' }),
    ).toThrow(/no option nope/u);
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
});

describe('the run configuration', () => {
  it('regression: a deadline nearly used up names the variable, not a killed command', () => {
    expect(failureOf(() => remainingMs(1_001, 1_000, 'JOURNEY_PREPARE_TIMEOUT_MS')).message).toBe(
      'the run ran out of JOURNEY_PREPARE_TIMEOUT_MS',
    );
    expect(remainingMs(1_000 + MIN_COMMAND_MS, 1_000, 'X')).toBe(MIN_COMMAND_MS);
  });

  it('regression: a blank JOURNEY_WORK_DIR is unset, never the current directory', () => {
    expect(workDirectoryOf(undefined)).toBeNull();
    expect(workDirectoryOf('')).toBeNull();
    expect(workDirectoryOf('  ')).toBeNull();
    expect(workDirectoryOf('/tmp/journey')).toBe('/tmp/journey');
  });

  it('JOURNEY_REGISTRY: unset or blank keeps Verdaccio; a URL is the registry; anything else stops (#608)', () => {
    expect(registryOf(undefined)).toBeNull();
    expect(registryOf(' ')).toBeNull();
    expect(registryOf('https://registry.npmjs.org')).toBe('https://registry.npmjs.org/');
    expect(registryOf(' https://registry.npmjs.org/ ')).toBe('https://registry.npmjs.org/');
    for (const value of ['registry.npmjs.org', 'file:///tmp', 'https://user:token@example.com/']) {
      expect(failureOf(() => registryOf(value)).message).toBe(
        'JOURNEY_REGISTRY must be an http(s) registry URL without credentials',
      );
    }
  });

  it('regression: writes the registry token under its own temporary directory, removed in finally', () => {
    const source = readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
    expect(source).toContain("path.join(secrets, 'publish.npmrc')");
    expect(source).not.toContain("path.join(work, 'publish.npmrc')");
    expect(source).toMatch(
      /finally \{\n\s+rmSync\(secrets, \{ recursive: true, force: true \}\);/u,
    );
  });

  it('regression: reads a snapshot back only as a flat string map', () => {
    expect(stringMapOf('{"a.ts":"00","b/c.ts":"ff"}', 'snapshot')).toEqual({
      'a.ts': '00',
      'b/c.ts': 'ff',
    });
    expect(failureOf(() => stringMapOf('not json', 'snapshot')).message).toBe(
      'snapshot printed no JSON',
    );
    expect(failureOf(() => stringMapOf('["a"]', 'snapshot')).message).toBe(
      'snapshot printed no JSON object',
    );
    expect(failureOf(() => stringMapOf('null', 'snapshot')).message).toBe(
      'snapshot printed no JSON object',
    );
    expect(failureOf(() => stringMapOf('{"a.ts":{"x":1}}', 'snapshot')).message).toBe(
      'snapshot: a.ts is not a string',
    );
  });
});

describe('regression: the workflow that runs the journey', () => {
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  /** One top-level job of ci.yml, split the way scripts/check-workflows.mjs splits it. */
  function jobBlock(jobId: string): string {
    const lines = ci.split(/\r?\n/u);
    const start = lines.indexOf(`  ${jobId}:`);
    if (start < 0) throw new Error(`ci.yml has no ${jobId} job`);
    const nextJob = lines.findIndex(
      (line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:\s*$/u.test(line),
    );
    return lines.slice(start, nextJob < 0 ? undefined : nextJob).join('\n');
  }

  const workflow = jobBlock('journey-e2e');
  const scopePattern = /^ {10}pattern='([^']+)'$/mu.exec(workflow)?.[1];
  if (scopePattern === undefined) {
    throw new Error("the journey-e2e job has no scope step line `pattern='…'`");
  }
  const scope = new RegExp(scopePattern, 'u');

  /** Whether a pull request touching this file runs the journey (the scope step's grep -E). */
  function filtered(file: string): boolean {
    return scope.test(file);
  }

  /** Every repository file run.mjs loads through relative imports, directly or not. */
  function localImports(entry: string): string[] {
    const seen = new Set<string>();
    const pending = [entry];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const source = readFileSync(path.join(ROOT, next), 'utf8');
      for (const match of source.matchAll(/^import [^;]*? from '(\.{1,2}\/[^']+)';$/gmsu)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        pending.push(path.posix.join(path.posix.dirname(next), specifier));
      }
    }
    return [...seen].sort();
  }

  it('runs on a change to any file the journey imports or builds with', () => {
    const imported = localImports('tests/journey/run.mjs');
    expect(imported).toContain('tests/generated-project/images.mjs');
    expect(imported.filter((file) => !filtered(file))).toEqual([]);
    for (const file of [
      '.github/actions/nx-remote-cache/action.yml',
      '.github/actions/workspace-build/action.yml',
      '.github/actions/free-disk/action.yml',
      'scripts/ci/nx.sh',
      'nx.json',
      'tsconfig.json',
      'tsconfig.root.json',
      'playwright.journey.config.mjs',
      '.github/workflows/ci.yml',
    ]) {
      expect(filtered(file)).toBe(true);
    }
    expect(filtered('docs/operations/ci.md')).toBe(false);
    // The packages come built from ci.yml's `build` job; the journey job never runs an Nx build.
    expect(workflow).toContain('uses: ./.github/actions/workspace-build');
    expect(workflow).not.toContain('scripts/ci/nx.sh');
    expect(workflow).toContain('run: node tests/journey/run.mjs');
  });

  it('#514: is a ci-success need, filtered in a step, never an unrequired workflow of its own', () => {
    expect(existsSync(path.join(ROOT, '.github', 'workflows', 'journey-e2e.yml'))).toBe(false);
    // One line, or wrapped by Prettier once the list passes the print width.
    const needs = /^ {4}needs:\s*\[([^\]]*)\]$/mu.exec(jobBlock('ci-success'))?.[1] ?? '';
    expect(needs.split(',').map((job) => job.trim())).toContain('journey-e2e');
    // Only the heavy-tier condition (ci.yml, COST) may skip the job.
    expect(workflow).not.toMatch(/^ {4}if:(?! >-\r?\n {6}github\.event_name == 'schedule')/mu);
    expect(workflow).toContain('name: developer journey · ${{ matrix.part }}');
  });

  it('uploads evidence only from where run.mjs writes it', () => {
    const uploads = [...workflow.matchAll(/^ {10}path: (.+)$/gmu)].map((match) => match[1]);
    expect(uploads).toEqual([
      '${{ runner.temp }}/journey/journey-timings.json',
      '${{ runner.temp }}/journey-first-hour/first-hour-timings.json',
      '${{ runner.temp }}/journey/evidence/',
    ]);
  });

  it('fits run.mjs caps inside the step timeout, and every step inside the job timeout', () => {
    const numberOf = (pattern: RegExp): number => Number(pattern.exec(workflow)?.[1] ?? Number.NaN);
    const job = numberOf(/^ {4}timeout-minutes: (\d+)$/mu);
    const install = numberOf(/- name: Install\n {8}timeout-minutes: (\d+)/u);
    const journey = numberOf(
      /- name: Run the developer journey on a clean container\n {8}timeout-minutes: (\d+)/u,
    );
    const prepareMs = numberOf(/JOURNEY_PREPARE_TIMEOUT_MS: '(\d+)'/u);
    const checksMs = numberOf(/JOURNEY_CHECKS_TIMEOUT_MS: '(\d+)'/u);
    for (const value of [job, install, journey, prepareMs, checksMs]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
    // Each timed block: its budget plus run.mjs's one minute to report it — B1, then S2-08's B2,
    // B3b and B3a — and two untimed checks caps, B1's and the ceiling and secret checks'.
    const blockMs = (seconds: number) => (seconds + 60) * 1000;
    const timedMs =
      blockMs(JOURNEY_BUDGET_SECONDS) +
      blockMs(JOURNEY_LOOK_CHANGE_BUDGET_SECONDS) +
      2 * blockMs(JOURNEY_TOOL_BUDGET_SECONDS);
    const cleanupMs = 3 * 60_000;
    expect(prepareMs + timedMs + 2 * checksMs + cleanupMs).toBeLessThanOrEqual(journey * 60_000);
    const setupAndUploads = 5;
    const firstHour = numberOf(
      /- name: Time the first hour\n(?:.*\n)*? {8}timeout-minutes: (\d+)/u,
    );
    expect(Number.isSafeInteger(firstHour)).toBe(true);
    // First-hour step: prepare, the exec cap (the spec's own test timeout plus a minute), the read, cleanup.
    const execMinutes = Number(
      /FIRST_HOUR_EXEC_MS = (\d+) \* 60_000/u.exec(
        readFileSync(path.join(HERE, 'run.mjs'), 'utf8'),
      )?.[1],
    );
    const specMinutes = Number(
      /test\.setTimeout\((\d+) \* 60_000\)/u.exec(
        readFileSync(path.join(HERE, 'first-hour.e2e.mjs'), 'utf8'),
      )?.[1],
    );
    expect(execMinutes).toBeGreaterThan(specMinutes);
    expect(prepareMs / 60_000 + execMinutes + 1 + 3).toBeLessThanOrEqual(firstHour);
    expect(install + journey + firstHour + setupAndUploads).toBeLessThanOrEqual(job);
  });
});

describe('the first-hour code tool (issue #693)', () => {
  it('declares its run file project-relative, as the tool host resolves it', () => {
    const spec = readFileSync(path.join(HERE, 'first-hour.e2e.mjs'), 'utf8');
    const run = /run: '\.\/(tools\/[^']+\.run\.ts)'/u.exec(spec)?.[1];
    expect(run).toBeDefined();
    expect(spec).toContain(`writeProjectFile(
        '${run}'`);
  });
});

describe('the reply through the default model connection', () => {
  it('passes on a POST /v1/messages that answered the nonce under the generated key', () => {
    expect(() =>
      assertReplyRecorded(
        [record({ method: 'GET', path: '/v1/models', reply: null }), record({})],
        NONCE,
        KEY,
      ),
    ).not.toThrow();
  });

  it('fails when no reply names the nonce', () => {
    const failure = failureOf(() =>
      assertReplyRecorded(
        [
          record({
            reply: 'Fake Anthropic reply to e2e-nonce-other: the generated project answered.',
          }),
        ],
        NONCE,
        KEY,
      ),
    );
    expect(failure.message).toBe(`the fake provider never answered ${NONCE}`);
  });

  it('fails when the reply came under another key, and never prints either key', () => {
    const failure = failureOf(() =>
      assertReplyRecorded([record({ apiKey: 'sk-ant-e2e-fake-other' })], NONCE, KEY),
    );
    expect(failure.message).toBe(
      `the fake provider answered ${NONCE}, but never under the generated key`,
    );
    expect(failure.message).not.toContain(KEY);
    expect(failure.message).not.toContain('sk-ant-e2e-fake-other');
  });
});

describe('demo/ is not edited by hand', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function demo(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'journey-harness-'));
    directories.push(directory);
    mkdirSync(path.join(directory, 'agents'));
    mkdirSync(path.join(directory, 'surfaces'));
    writeFileSync(path.join(directory, 'agent-workspace.yaml'), 'apiVersion: v2\n');
    writeFileSync(path.join(directory, 'agents', 'assistant.ts'), AGENT_SOURCE);
    writeFileSync(path.join(directory, 'surfaces', 'main.ts'), SURFACE_SOURCE);
    return directory;
  }

  it('lists a written, a changed and a removed file by path', () => {
    const directory = demo();
    const before = snapshotTree(directory);
    expect(Object.keys(before)).toEqual([
      'agent-workspace.yaml',
      'agents/assistant.ts',
      'surfaces/main.ts',
    ]);
    writeFileSync(path.join(directory, 'agents', 'helper.ts'), 'export {};\n');
    writeFileSync(
      path.join(directory, 'surfaces', 'main.ts'),
      SURFACE_SOURCE.replace('#2F5FD0', '#000000'),
    );
    rmSync(path.join(directory, 'agent-workspace.yaml'));
    const after = snapshotTree(directory);
    expect(diffTrees(before, after)).toEqual({
      added: ['agents/helper.ts'],
      changed: ['surfaces/main.ts'],
      removed: ['agent-workspace.yaml'],
    });
    expect(failureOf(() => assertUnchanged('demo', before, after)).message).toBe(
      [
        'demo/ changed after init:',
        '  added: agents/helper.ts',
        '  changed: surfaces/main.ts',
        '  removed: agent-workspace.yaml',
      ].join('\n'),
    );
  });

  it('ignores the tool-owned paths: node_modules/, package-lock.json, the runtime state and .aw/', () => {
    expect(TOOL_OWNED_PATHS).toEqual([
      'node_modules/',
      'package-lock.json',
      '.agent-workspace/',
      '.aw/',
    ]);
    const directory = demo();
    const before = snapshotTree(directory);
    mkdirSync(path.join(directory, 'node_modules', '@indx-workspace'), { recursive: true });
    writeFileSync(path.join(directory, 'node_modules', '@indx-workspace', 'x.js'), '');
    writeFileSync(path.join(directory, 'package-lock.json'), '{}\n');
    mkdirSync(path.join(directory, '.agent-workspace', 'pg'), { recursive: true });
    writeFileSync(path.join(directory, '.agent-workspace', 'pg', 'PG_VERSION'), '17\n');
    mkdirSync(path.join(directory, '.aw', 'logs'), { recursive: true });
    writeFileSync(path.join(directory, '.aw', 'logs', 'runtime.log'), 'started');
    expect(() => assertUnchanged('demo', before, snapshotTree(directory))).not.toThrow();
  });

  it('does not take a nested package-lock.json for the tool-owned one', () => {
    const directory = demo();
    const before = snapshotTree(directory);
    writeFileSync(path.join(directory, 'agents', 'package-lock.json'), '{}\n');
    expect(
      failureOf(() => assertUnchanged('demo', before, snapshotTree(directory))).message,
    ).toContain('  added: agents/package-lock.json');
  });
});

describe('the timing record', () => {
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
});

describe('redaction', () => {
  it('replaces every occurrence of the fake key', () => {
    expect(redact(`key=${KEY}\nagain ${KEY}`, KEY)).toBe('key=<fake key>\nagain <fake key>');
  });

  it('leaves the text alone for a blank secret', () => {
    expect(redact('nothing secret', '')).toBe('nothing secret');
  });
});

describe('the untimed checks read what aw prints', () => {
  it('moves the rendered agent to engine pi with one mcp() tool', () => {
    const source = mcpAgentSource(AGENT_SOURCE, 'journey-mcp');
    expect(source).toContain("import { defineAgent, mcp } from '@indx-workspace/sdk/define';");
    expect(source).toContain("  engine: 'pi',\n  tools: [mcp('journey-mcp')],\n");
    expect(source).not.toContain('claude-agent-sdk');
    expect(agentNameOfSource(source)).toBe('assistant');
  });

  it('edits the real rendered support-starter agent, which also imports skill', () => {
    const file = renderProjectFiles(withRecommendedAnswers({ 'setup.theme': 'support' }), {
      name: 'demo',
    }).find((f) => f.path.startsWith('agents/'));
    const rendered = String(file?.contents);
    expect(rendered).toContain('import { defineAgent, skill } from');
    const mcpSource = mcpAgentSource(rendered, 'journey-mcp');
    expect(mcpSource).toContain(
      "import { defineAgent, skill, mcp } from '@indx-workspace/sdk/define';",
    );
    expect(mcpSource).toContain("  tools: [mcp('journey-mcp')],");
    expect(toolAgentSource(rendered)).toContain("import ordersTool from '../tools/orders';");
  });

  it('refuses an agent file that is not the renderer output', () => {
    expect(failureOf(() => mcpAgentSource('export default {};\n', 'journey-mcp')).message).toBe(
      'the agent file is not the renderer output (import and engine line)',
    );
  });

  it('finds the agent id by name', () => {
    const listing = JSON.stringify([
      { id: 'agt_1', name: 'helper' },
      { id: 'agt_2', name: 'assistant' },
    ]);
    expect(agentIdOf(listing, 'assistant')).toBe('agt_2');
    expect(failureOf(() => agentIdOf(listing, 'missing')).message).toBe(
      'the workspace has no agent named missing',
    );
  });
});

describe('regressions: the pinned images and the registry config', () => {
  it('runs the Playwright image of the root @playwright/test version', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const version = manifest.devDependencies['@playwright/test'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(
      PLAYWRIGHT_IMAGE.startsWith(`mcr.microsoft.com/playwright:v${String(version)}-noble@`),
    ).toBe(true);
  });

  it('pins both images by digest', () => {
    for (const image of [PLAYWRIGHT_IMAGE, VERDACCIO_IMAGE]) {
      expect(image).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/u);
    }
  });

  it('keeps @indx-workspace/* local with no proxy, and proxies the rest to npmjs', () => {
    const config = readFileSync(path.join(HERE, 'verdaccio.yaml'), 'utf8');
    const blocks = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const line of config.split('\n')) {
      const key = /^ {2}'([^']+)':$/u.exec(line)?.[1];
      if (key !== undefined) {
        current = [];
        blocks.set(key, current);
      } else if (/^ {4}\S/u.test(line)) current?.push(line.trim());
      else current = undefined;
    }
    const scope = blocks.get('@indx-workspace/*');
    expect(scope).toBeDefined();
    expect(scope?.some((line) => line.startsWith('proxy:'))).toBe(false);
    expect(scope).toContain('access: $all');
    expect(scope).toContain('publish: $authenticated');
    expect(blocks.get('**')).toContain('proxy: npmjs');
    expect([...blocks.keys()][0]).toBe('@indx-workspace/*');
    expect(config).toMatch(/^max_body_size: 300mb$/mu);
    expect(config).toMatch(/^ {4}max_users: 1$/mu);
  });
});

describe('S2-08: the B2 and B3 budgets', () => {
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
    expect(totalLine(report, 'B2 look change')).toBe(
      'journey: B2 look change 12.3 s (budget 60 s)',
    );
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
});

describe('S2-08: the tool call', () => {
  const TOKEN = 'orders-e2e-0123456789abcdef';
  function call(authorization: string | null, route = `/orders/${NONCE}`) {
    return { method: 'GET', path: route, authorization };
  }

  it('passes when the orders API saw GET /orders/<nonce> with the token', () => {
    expect(() => assertToolCallSeen([call(`Bearer ${TOKEN}`)], NONCE, TOKEN)).not.toThrow();
  });

  it('fails on no call, on the wrong path, and on a wrong or missing token, naming neither token', () => {
    expect(failureOf(() => assertToolCallSeen([], NONCE, TOKEN)).message).toBe(
      `the orders API never saw GET /orders/${NONCE}`,
    );
    expect(
      failureOf(() => assertToolCallSeen([call(`Bearer ${TOKEN}`, '/orders/other')], NONCE, TOKEN))
        .message,
    ).toBe(`the orders API never saw GET /orders/${NONCE}`);
    for (const authorization of ['Bearer orders-e2e-wrong', null, TOKEN]) {
      const failure = failureOf(() => assertToolCallSeen([call(authorization)], NONCE, TOKEN));
      expect(failure.message).toBe(
        `the orders API saw GET /orders/${NONCE}, but never with the token`,
      );
      expect(failure.message).not.toContain(TOKEN);
      expect(failure.message).not.toContain('orders-e2e-wrong');
    }
  });

  it("fails when the answer lacks the tool's data", () => {
    const withData = record({
      reply: `Fake Anthropic reply to ${NONCE}: {"note":"order-data-${NONCE}"}`,
    });
    expect(() => assertToolAnswer([withData], NONCE)).not.toThrow();
    expect(failureOf(() => assertToolAnswer([record({})], NONCE)).message).toBe(
      `the fake provider answered ${NONCE} without the tool's data (order-data-${NONCE})`,
    );
    expect(failureOf(() => assertToolAnswer([], NONCE)).message).toBe(
      `the fake provider never answered ${NONCE}`,
    );
  });
});

describe('S2-08: Bash offered before the ceiling, denied under it', () => {
  const ORDERS = 'mcp__orders__getOrderByOrderNumber';
  function turn(toolNames: string[], nonce: string | null = NONCE) {
    return { nonce, toolNames };
  }

  it('passes the baseline with Bash and the ceiling run without it', () => {
    expect(() => assertToolOffered([turn(['Bash', ORDERS])], NONCE, 'Bash', true)).not.toThrow();
    expect(() => assertToolOffered([turn(['Read', ORDERS])], NONCE, 'Bash', false)).not.toThrow();
  });

  it('fails when Bash is offered under the ceiling', () => {
    expect(
      failureOf(() => assertToolOffered([turn(['Bash', ORDERS])], NONCE, 'Bash', false)).message,
    ).toBe(`Bash was offered to the model for ${NONCE} under the ceiling`);
  });

  it('fails when the baseline does not offer Bash, so the denial would prove nothing', () => {
    expect(failureOf(() => assertToolOffered([turn([ORDERS])], NONCE, 'Bash', true)).message).toBe(
      `Bash was not offered to the model for ${NONCE}, so its denial would prove nothing`,
    );
  });

  it('fails when no agent turn for the nonce offered the orders tool', () => {
    const turns = [turn([]), turn(['Bash', ORDERS], 'e2e-nonce-other')];
    expect(failureOf(() => assertToolOffered(turns, NONCE, 'Bash', false)).message).toBe(
      `no model request for ${NONCE} offered the orders tool`,
    );
  });
});

describe('S2-08: the ceiling refusal comes from the server', () => {
  const FILE = 'agents/assistant.ts';
  const LINE = `${FILE}: 403 policy_cannot_widen [permissions.runCommands]`;

  it('passes on the 403 line, with or without a hint', () => {
    expect(() => assertServerRefusal(`checking\n${LINE}\r\n`, FILE)).not.toThrow();
    expect(() => assertServerRefusal(`${LINE}; ask an admin`, FILE)).not.toThrow();
  });

  it('fails on the local form: computed without the server', () => {
    expect(
      failureOf(() =>
        assertServerRefusal(`${FILE}: local policy_cannot_widen [permissions.runCommands]`, FILE),
      ).message,
    ).toBe(`policy_cannot_widen for ${FILE} was computed without the server`);
  });

  it('fails when the line is absent, or names another detail', () => {
    const expected = `no "${LINE}" line`;
    expect(
      failureOf(() => assertServerRefusal('synced: "assistant" unchanged', FILE)).message,
    ).toBe(expected);
    expect(
      failureOf(() =>
        assertServerRefusal(
          `${FILE}: 403 policy_cannot_widen [permissions.runCommands, engine]`,
          FILE,
        ),
      ).message,
    ).toBe(expected);
  });
});

describe('S2-08: the token is absent', () => {
  const TOKEN = 'orders-e2e-feedfacecafebeef';
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function write(root: string, relative: string, contents: string): void {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), contents);
  }

  it('finds the token in a file and a transcript, but not in the sealed store or node_modules', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'journey-secret-'));
    directories.push(root);
    expect(SEALED_PATHS).toEqual(['node_modules/', '.agent-workspace/postgres/']);
    write(root, 'agents/assistant.ts', AGENT_SOURCE);
    write(root, '.env', `ORDERS_TOKEN=${TOKEN}\n`);
    write(root, '.agent-workspace/storage/sessions/x', `{"text":"${TOKEN}"}`);
    write(root, '.agent-workspace/postgres/base/1', `sealed ${TOKEN}`);
    write(root, 'node_modules/pkg/index.js', TOKEN);
    expect(filesContaining(root, TOKEN)).toEqual(['.agent-workspace/storage/sessions/x', '.env']);
    expect(failureOf(() => filesContaining(root, '')).message).toBe(
      'the secret check was given no secret',
    );
  });

  it('names the place holding the token, never the token', () => {
    expect(() =>
      assertSecretAbsent({ 'dev-1.log': 'ready', environ: 'PATH=/bin' }, TOKEN),
    ).not.toThrow();
    const failure = failureOf(() =>
      assertSecretAbsent(
        { 'dev-1.log': `token ${TOKEN}`, environ: `ORDERS_TOKEN=${TOKEN}`, other: 'x' },
        TOKEN,
      ),
    );
    expect(failure.message).toBe('the token appears in: dev-1.log, environ');
    expect(failure.message).not.toContain(TOKEN);
  });
});

describe('S2-08: no file setup wrote is edited', () => {
  const before = { 'tools/orders.ts': 'aa', 'agents/assistant.ts': 'bb' };
  const input = 'apis/orders.openapi.json';

  it("allows the developer's document to be added", () => {
    expect(() =>
      assertUnchanged('demo-tools', before, { ...before, [input]: 'cc' }, [input]),
    ).not.toThrow();
  });

  it('still fails on a changed generated file, and on any other added file', () => {
    const edited = { ...before, [input]: 'cc', 'tools/orders.ts': 'ff' };
    expect(failureOf(() => assertUnchanged('demo-tools', before, edited, [input])).message).toBe(
      'demo-tools/ changed after init:\n  changed: tools/orders.ts',
    );
    const extra = { ...before, [input]: 'cc', 'tools/extra.ts': 'dd' };
    expect(failureOf(() => assertUnchanged('demo-tools', before, extra, [input])).message).toBe(
      'demo-tools/ changed after init:\n  added: tools/extra.ts',
    );
  });
});

describe('S2-08: the hand edits B2 and B3b make', () => {
  it('adds the orders tool and runCommands to the rendered agent', () => {
    const source = toolAgentSource(AGENT_SOURCE);
    expect(source).toContain(
      "import { defineAgent } from '@indx-workspace/sdk/define';\n\nimport ordersTool from '../tools/orders';\n",
    );
    expect(source).toContain(
      "  engine: 'claude-agent-sdk',\n  tools: [ordersTool],\n  permissions: { runCommands: true },\n",
    );
    expect(agentNameOfSource(source)).toBe('assistant');
  });

  it('refuses an agent that is not the renderer output, or already has tools', () => {
    const message =
      'the agent file is not the renderer output without tools (import and engine line)';
    expect(failureOf(() => toolAgentSource('export default {};\n')).message).toBe(message);
    expect(failureOf(() => toolAgentSource(toolAgentSource(AGENT_SOURCE))).message).toBe(message);
  });

  it('rewrites the surface colour, and refuses a file with none or a colour that is not #rrggbb', () => {
    const source = withSurfaceColour(SURFACE_SOURCE, '#16a085');
    expect(colourOfSurfaceSource(source)).toBe('#16a085');
    expect(source.replace("'#16a085'", "'#2F5FD0'")).toBe(SURFACE_SOURCE);
    expect(
      failureOf(() => withSurfaceColour("export default { name: 'main' };", '#16a085')).message,
    ).toBe('surfaces/main.ts names no theme colour (colour: #rrggbb)');
    expect(failureOf(() => withSurfaceColour(SURFACE_SOURCE, 'teal')).message).toBe(
      'teal is not a #rrggbb colour',
    );
  });
});

describe('#609: the live switch and its record', () => {
  it('runs the fake by default, and --live only with a non-blank ANTHROPIC_API_KEY', () => {
    expect(journeyMode([], {})).toEqual({ live: false });
    expect(journeyMode(['--live'], { ANTHROPIC_API_KEY: ' sk-ant-x ' })).toEqual({
      live: true,
      apiKey: 'sk-ant-x',
    });
    const missing =
      '--live needs ANTHROPIC_API_KEY: an Owner must add the repository secret ANTHROPIC_API_KEY';
    expect(failureOf(() => journeyMode(['--live'], {})).message).toBe(missing);
    expect(failureOf(() => journeyMode(['--live'], { ANTHROPIC_API_KEY: '  ' })).message).toBe(
      missing,
    );
  });

  it('splits --first-hour off, alone and with --live, before journeyMode sees the rest', () => {
    expect(splitFirstHour(['--first-hour'])).toEqual({ firstHour: true, rest: [] });
    expect(splitFirstHour(['--first-hour', '--live'])).toEqual({
      firstHour: true,
      rest: ['--live'],
    });
    expect(splitFirstHour(['--live'])).toEqual({ firstHour: false, rest: ['--live'] });
    expect(failureOf(() => journeyMode(['--first-hour'], {})).message).toMatch(/^usage: /u);
  });

  it('refuses any other argument', () => {
    expect(failureOf(() => journeyMode(['--fake'], {})).message).toMatch(
      /^usage: node tests\/journey\/run\.mjs \[--live\] \(/u,
    );
    expect(failureOf(() => journeyMode(['live'], {})).message).toMatch(/^usage: /u);
  });

  it('reads the one first-token line a widget test prints, in seconds', () => {
    expect(firstTokenOf('  ✓  1 [chromium] …\njourney-first-token-ms 2345\r\n  1 passed\n')).toBe(
      2.3,
    );
    const none = 'the widget test printed 0 journey-first-token-ms lines, not one';
    expect(failureOf(() => firstTokenOf('1 passed\n')).message).toBe(none);
    expect(failureOf(() => firstTokenOf('journey-first-token-ms soon\n')).message).toBe(none);
    expect(
      failureOf(() => firstTokenOf('journey-first-token-ms 1\njourney-first-token-ms 2\n')).message,
    ).toBe('the widget test printed 2 journey-first-token-ms lines, not one');
  });

  it('reads a run and a session token only from the shapes the API answers', () => {
    expect(runOf({ run: { id: 'r1', status: 'completed', engine: 'pi' } }, 'GET')).toEqual({
      id: 'r1',
      status: 'completed',
    });
    for (const body of [
      null,
      {},
      { run: null },
      { run: { id: 'r1' } },
      { id: 'r1', status: 'x' },
    ]) {
      expect(failureOf(() => runOf(body, 'the run start')).message).toBe(
        'the run start answered no run',
      );
    }
    expect(sessionTokenOf({ token: 'awb_x', sessionId: 's' })).toBe('awb_x');
    for (const body of [null, {}, { token: '' }, { token: 1 }]) {
      expect(failureOf(() => sessionTokenOf(body)).message).toBe(
        'POST /p/s/main/sessions answered no token',
      );
    }
  });

  // Regressions (CI runs 37141361195 and 37143036089): the local driver's notice and Next's empty
  // route-announcer live region are alerts, not a turn's failure. The fake answers every alert
  // whatever the selector: the worst case of a selector that matches too much.
  it('fails on a failed turn, never on an empty live region or the local driver notice', async () => {
    const selectors: string[] = [];
    const chatWith = (...alerts: { testid: string | null; text: string }[]) => ({
      locator: (selector: string) => {
        selectors.push(selector);
        return {
          all: () =>
            Promise.resolve(
              alerts.map(({ testid, text }) => ({
                getAttribute: () => Promise.resolve(testid),
                innerText: () => Promise.resolve(text),
              })),
            ),
        };
      },
    });
    const notice = {
      testid: 'driver-in-force',
      text: 'Runtime driver in force: local — No tenant isolation: commands run as the host user',
    };
    const announcer = { testid: null, text: '' };
    await expect(assertNoChatFailure(chatWith())).resolves.toBeUndefined();
    // (a) an empty role=alert live region beside a successful answer
    await expect(assertNoChatFailure(chatWith(announcer))).resolves.toBeUndefined();
    await expect(assertNoChatFailure(chatWith({ testid: null, text: ' \n ' }))).resolves.toBe(
      undefined,
    );
    // (b) the local driver's notice beside a successful answer
    await expect(assertNoChatFailure(chatWith(notice, announcer))).resolves.toBeUndefined();
    // (c) a failed turn, reported with its text
    await expect(
      assertNoChatFailure(
        chatWith(announcer, notice, { testid: null, text: ' run_failed: boom ' }),
      ),
    ).rejects.toThrow(new JourneyFailure('the chat shows a failure: run_failed: boom'));
    // Only surface-chat.tsx's failure element, the alert after the messages, is read.
    expect(new Set(selectors)).toEqual(new Set(['ol[aria-live="polite"] ~ [role="alert"]']));
  });

  it("asks for the fake's wording in stub mode only", () => {
    expect(stubExpectation(false, 'order-data-n1')).toEqual({
      JOURNEY_EXPECT_TEXT: 'order-data-n1',
    });
    expect(stubExpectation(true, 'order-data-n1')).toEqual({});
  });

  it('redacts every secret from copied evidence, and drops a binary file it cannot redact', () => {
    const secrets = new Set(['sk-ant-live', '']);
    const json = Buffer.from('{"key":"sk-ant-live","again":"sk-ant-live"}');
    expect(scrubbedEvidence(json, secrets)?.toString()).toBe(
      '{"key":"<fake key>","again":"<fake key>"}',
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    expect(scrubbedEvidence(png, secrets)).toBe(png);
    expect(scrubbedEvidence(Buffer.concat([png, Buffer.from('sk-ant-live')]), secrets)).toBeNull();
  });

  it('keeps the live journey out of the required checks, and refuses a missing secret first', () => {
    const live = readFileSync(path.join(ROOT, '.github', 'workflows', 'journey-live.yml'), 'utf8');
    const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).not.toContain('--live');
    expect(ci).not.toContain('journey-live');
    const steps = [...live.matchAll(/^ {6}- name: (.+)$/gmu)].map((match) => match[1]);
    expect(steps[0]).toBe('Refuse a missing live-model secret');
    expect(live).toContain('::error title=Missing secret ANTHROPIC_API_KEY::');
    expect(live).toContain('run: node tests/journey/run.mjs --live');
    expect(live).toMatch(/^ {4}- cron: /mu);
    expect(live).toMatch(/^ {2}workflow_dispatch:$/mu);
    expect(live).toContain('run: node tests/journey/run.mjs --first-hour --live');
    const secretReferences = /\$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/gu;
    // The key reaches only the step that refuses it and the two steps that run a journey.
    const [journeyJob = '', liveLane = ''] = live.split(/^ {2}platforms-live-managed-agents:$/mu);
    expect(journeyJob.match(secretReferences)).toHaveLength(3);
    // Issue #979: the live Managed Agents lane likewise reads it in its refusal step and its lane step.
    expect(liveLane.match(secretReferences)).toHaveLength(2);
    expect(live).not.toMatch(/^ {4}env:/mu);
  });
});

describe('the first-hour stopwatch helpers (issue #700)', () => {
  it('reads the quickstart commands as the page writes them', () => {
    const page = readFileSync(
      path.join(ROOT, 'docs', 'sdk', 'site', 'getting-started', 'quickstart.mdx'),
      'utf8',
    );
    const commands = quickstartCommands(page);
    expect(commands.map((command) => command.split(' ').slice(0, 3).join(' '))).toEqual([
      'npm create @indx-workspace@latest',
      'cd my-agent',
      'npm run dev',
    ]);
    expect(commands[0]).toMatch(/^npm create @indx-workspace@\S+ my-agent -- --yes$/u);
    expect(commands.some((command) => command.startsWith('export '))).toBe(false);
    expect(commands.every((command) => !command.includes('#'))).toBe(true);
    expect(quickstartCommands('x\n```sh\n# c\na && b  # d\n```\n')).toEqual(['a', 'b']);
    // The docs-claims marker on the fence does not hide the block.
    expect(quickstartCommands('x\n```sh title="t" claim="run"\na && b\n```\n')).toEqual(['a', 'b']);
    // Only a placeholder export (value ending in `...`) is dropped; a real one is a command.
    expect(quickstartCommands('x\n```sh\nexport K=sk-ant-...\nexport A=1\nnpm i\n```\n')).toEqual([
      'export A=1',
      'npm i',
    ]);
    expect(failureOf(() => quickstartCommands('no block')).message).toMatch(/no ```sh block/u);
  });

  it('summarises timed and pending steps', () => {
    const markdown = firstHourSummaryMarkdown([
      { id: 'T2', name: 'npm install', seconds: 44, targetSeconds: 30 },
      { id: 'T3', name: 'aw dev ready', seconds: 6.4, targetSeconds: 15 },
      { id: 'T4', name: 'aw chat', pending: 'FH-10' },
    ]);
    expect(markdown).toContain('| T2 npm install | 44.0 | 30 | over target |');
    expect(markdown).toContain('| T3 aw dev ready | 6.4 | 15 | timed |');
    expect(markdown).toContain('| T4 aw chat | |  | pending FH-10 |');
  });
});
