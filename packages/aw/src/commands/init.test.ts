import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SETUP_QUESTIONS,
  SETUP_THEMES,
  withRecommendedAnswers,
} from '@indx-workspace/contracts/setup';
import {
  askSetupQuestions,
  parseProjectFile,
  ENGINE_PACKAGES,
  parseSetupFlags,
  projectDependencies,
  projectNameFor,
  renderProjectFiles,
} from '@indx-workspace/sdk/project';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliIo } from '../io.js';
import { EXIT_CODE } from '../output.js';
import { loadProject } from '../project/load.js';
import { runCli, tempDirectory, tempFile, type CliRunOptions } from '../testing.js';
import { AW_VERSION } from '../version.js';

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A fresh, empty project directory with a name `projectNameFor` has to clean up. */
async function emptyProject(): Promise<string> {
  const root = await tempDirectory();
  temporary.push(root);
  const directory = path.join(root, 'My Project');
  await mkdir(directory);
  return directory;
}

function golden(directory: string) {
  return renderProjectFiles(withRecommendedAnswers({}), {
    name: projectNameFor(path.basename(directory)),
  });
}

const THEME_PROMPT =
  SETUP_QUESTIONS.find((question) => question.id === 'setup.theme')?.prompt ?? 'setup.theme';

/**
 * A terminal that answers the theme question with `theme`, `[y/N]` with `confirm`, and every other
 * question with the empty line (the recommended answer); records every question it was asked.
 */
function themeTerminal(theme: string, confirm = 'y') {
  const questions: string[] = [];
  const prompt = (question: string): Promise<string> => {
    questions.push(question);
    if (question.startsWith(THEME_PROMPT)) return Promise.resolve(theme);
    return Promise.resolve(question.endsWith('[y/N] ') ? confirm : '');
  };
  return { questions, prompt };
}

/** What every successful `aw init` ends with, for the recommended answers (#544). */
const CLOSING =
  'aw dev reads ANTHROPIC_API_KEY from its environment; no key is written to a file.\n' +
  'next: npx aw dev\n' +
  'to share a workspace later: aw login --url <url> (reads workspaces; pushing with it is not supported yet)\n';

function init(cwd: string, argv: readonly string[], options: CliRunOptions = {}) {
  return runCli(['init', ...argv], { cwd, env: {}, ...options });
}

/** The loader's I/O: no stdin and no network, as `project/load.test.ts` has it. */
const LOADER_IO: CliIo = {
  stdin: () => Promise.resolve(''),
  stdout: () => undefined,
  stderr: () => undefined,
  env: {},
  homeDir: 'C:/nonexistent-home',
  fetch: () => Promise.reject(new Error('no network')),
  isTty: false,
};

/** What a project needs with the recommended answers: the three packages and the default engine's. */
const ALL_PINS = Object.entries(projectDependencies(AW_VERSION, 'claude-agent-sdk'));
const ALL_SPECS = ALL_PINS.map(([name, version]) => `${name}@${version}`).join(' ');
const DEFAULT_ENGINE_SPECS = Object.entries(ENGINE_PACKAGES['claude-agent-sdk'])
  .map(([name, version]) => `${name}@${version}`)
  .join(' ');

describe('aw init (issue #451)', () => {
  it('--yes writes exactly the rendered starter files, which read back', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const files = golden(cwd);
    expect(files.map((file) => file.path)).toEqual([
      'agent-workspace.yaml',
      'agents/assistant.ts',
      'surfaces/main.ts',
      'README.md',
      'evals/assistant.yaml',
      'AGENTS.md',
      'skills/refund-policy/SKILL.md',
    ]);
    for (const file of files) {
      expect(await readFile(path.join(cwd, file.path), 'utf8')).toBe(file.contents);
    }
    expect(run.stdout).toBe(
      `${files.map((file) => `wrote ${file.path}\n`).join('')}wrote .gitignore\n`,
    );
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.agent-workspace/\n.aw/\n.env\n',
    );
    // The recommended theme, support, writes its greeting (#543).
    expect(await readFile(path.join(cwd, 'surfaces/main.ts'), 'utf8')).toContain(
      "greeting: 'Hi! How can I help you today?',",
    );
    const read = parseProjectFile(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8'));
    expect(read.lifted).toBe(false);
    expect(read.project).toMatchObject({ name: 'my-project' });
    // No package.json: create one first, then install all three, at this aw's version.
    expect(run.stderr).toBe(`next: npm init -y\nnext: npm install -D ${ALL_SPECS}\n${CLOSING}`);
    expect(existsSync(path.join(cwd, 'package.json'))).toBe(false);
  });

  it('answers setup questions by flag, and refuses a bad value like the interview (issue #689)', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--provider', 'openai', '--color', '#0f6b77']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const expected = renderProjectFiles(
      withRecommendedAnswers(parseSetupFlags({ provider: 'openai', color: '#0f6b77' })),
      { name: projectNameFor(path.basename(cwd)) },
    );
    for (const file of expected) {
      expect(await readFile(path.join(cwd, file.path), 'utf8')).toBe(file.contents);
    }
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toContain('openai');

    const bad = await init(await emptyProject(), ['--yes', '--provider', 'nope']);
    expect(bad.code).toBe(EXIT_CODE.usage);
    expect(bad.stderr).toContain('--provider:');
  });

  it('--platform writes the platforms block and the sections, and refuses an unknown id (#977)', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--platform', 'copilot-studio,claude-managed-agents']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const read = parseProjectFile(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8'));
    expect(read.project).toMatchObject({
      platforms: {
        'claude-managed-agents': { enabled: true },
        'copilot-studio': { enabled: true },
      },
    });
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toContain(
      'Publish to other agent platforms',
    );
    expect(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('Other agent platforms');

    const bad = await init(await emptyProject(), ['--yes', '--platform', 'eject-mastra']);
    expect(bad.code).toBe(EXIT_CODE.usage);
    expect(bad.stderr).toContain('--platform:');
  });

  it('--platform keeps an existing README.md byte for byte (#977)', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'README.md'), '# mine\n');
    const run = await init(cwd, ['--yes', '--platform', 'aws-agentcore']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe('# mine\n');
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toContain(
      'platforms:\n  aws-agentcore:\n    enabled: true\n',
    );
    expect(run.stdout).toContain('kept the existing README.md\n');
  });

  it('does not ask a question a flag answered', async () => {
    const cwd = await emptyProject();
    const { questions, prompt } = themeTerminal('', 'y');
    const run = await init(cwd, ['--theme', 'copilot'], { isTty: true, prompt });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(questions.some((question) => question.startsWith(THEME_PROMPT))).toBe(false);
  });

  it('--help lists every setup flag, generated from the question set', async () => {
    const run = await runCli(['init', '--help']);
    expect(run.code).toBe(EXIT_CODE.ok);
    for (const question of SETUP_QUESTIONS) {
      expect(run.stdout).toContain(`--${question.flag} <`);
      expect(run.stdout).toContain(question.prompt);
    }
  });

  it('refuses over existing files, listing every one, and writes nothing', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'agent-workspace.yaml'), 'mine\n');
    await mkdir(path.join(cwd, 'surfaces'));
    await writeFile(path.join(cwd, 'surfaces', 'main.ts'), 'mine\n');
    const run = await init(cwd, ['--yes']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('  agent-workspace.yaml\n');
    expect(run.stderr).toContain('  surfaces/main.ts');
    expect(run.stderr).not.toContain('agents/assistant.ts');
    expect(existsSync(path.join(cwd, 'agents'))).toBe(false);
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toBe('mine\n');
    expect(run.stdout).toBe('');
  });

  it('keeps an existing README.md and writes the rest', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'README.md'), 'mine\n');
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, 'README.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(true);
    expect(run.stdout).toContain('kept the existing README.md\n');
    expect(run.stdout).not.toContain('wrote README.md');
  });

  it('keeps an existing AGENTS.md and writes the rest', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'AGENTS.md'), 'mine\n');
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(true);
    expect(run.stdout).toContain('kept the existing AGENTS.md\n');
    expect(run.stdout).not.toContain('wrote AGENTS.md');
  });

  it('appends only the missing ignores to an existing .gitignore, keeping its lines', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, '.gitignore'), 'dist/\n/.env');
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      'dist/\n/.env\nnode_modules/\n.agent-workspace/\n.aw/\n',
    );
    expect(run.stdout).toContain('added node_modules/, .agent-workspace/, .aw/ to .gitignore\n');
  });

  it('names the .gitignore edit in the confirmation, and nothing when it is complete', async () => {
    const edited = await emptyProject();
    await writeFile(path.join(edited, '.gitignore'), 'dist/\n');
    const terminal = themeTerminal('', 'n');
    const run = await init(edited, [], { isTty: true, prompt: terminal.prompt });
    expect(run.stdout).toContain(
      'and add node_modules/, .agent-workspace/, .aw/, .env to the existing .gitignore\n',
    );
    const complete = await emptyProject();
    await writeFile(
      path.join(complete, '.gitignore'),
      'node_modules/\n.agent-workspace/\n.env\n.aw/\n',
    );
    const quiet = await init(complete, [], { isTty: true, prompt: themeTerminal('', 'n').prompt });
    expect(quiet.stdout).not.toContain('.gitignore');
  });

  it('leaves a .gitignore that already lists all four alone', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, '.gitignore'), 'node_modules\n.agent-workspace\n.aw\n.env\n');
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.agent-workspace\n.aw\n.env\n',
    );
    expect(run.stdout).not.toContain('.gitignore');
  });

  it('refuses without a terminal and without --yes, naming --yes', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, []);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('pass --yes when no person is at a terminal');
    expect(run.stderr).toContain('fix: aw init --yes');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);
  });

  it('refuses under CI=true with a terminal on stdin, naming --yes and asking nothing', async () => {
    const cwd = await emptyProject();
    const prompt = vi.fn(() => Promise.resolve(''));
    // `processIo` leaves isTty false when CI is set, whatever the streams are.
    const run = await init(cwd, [], {
      isTty: false,
      stdinIsTty: true,
      env: { CI: 'true' },
      prompt,
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('fix: aw init --yes');
    expect(prompt).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
  });

  it('refuses on a terminal that cannot prompt, naming --yes', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, [], { isTty: true });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('--yes');
  });

  it('on a terminal, shows the plan and writes nothing unless the answer is yes', async () => {
    const cwd = await emptyProject();
    const declinedTerminal = themeTerminal('', 'n');
    const declined = await init(cwd, [], { isTty: true, prompt: declinedTerminal.prompt });
    expect(declined.code).toBe(EXIT_CODE.ok);
    expect(declinedTerminal.questions.at(-1)).toBe('write these 7 files? [y/N] ');
    expect(declined.stdout).toContain('  agent-workspace.yaml\n');
    expect(declined.stdout).toContain('and create .gitignore\n');
    expect(declined.stdout).not.toContain('wrote');
    expect(declined.stderr).toBe('nothing written\n');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);

    const empty = await init(cwd, [], { isTty: true, prompt: themeTerminal('', '').prompt });
    expect(empty.code).toBe(EXIT_CODE.ok);
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);

    const accepted = await init(cwd, [], {
      isTty: true,
      prompt: themeTerminal('', ' Yes\n').prompt,
    });
    expect(accepted.code, accepted.stderr).toBe(EXIT_CODE.ok);
    expect(accepted.stderr.endsWith(CLOSING)).toBe(true);
    for (const file of golden(cwd)) {
      expect(await readFile(path.join(cwd, file.path), 'utf8')).toBe(file.contents);
    }
  });

  it.each(SETUP_THEMES)(
    'on a terminal, theme %s writes exactly the files create writes (C20)',
    async (theme) => {
      const cwd = await emptyProject();
      const reference = themeTerminal(theme);
      const answers = await askSetupQuestions(reference.prompt, () => undefined);
      const expected = renderProjectFiles(answers, { name: 'my-project', version: AW_VERSION });
      const terminal = themeTerminal(theme);

      const run = await init(cwd, [], { isTty: true, prompt: terminal.prompt });

      expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
      expect(terminal.questions).toEqual([
        ...reference.questions,
        `write these ${String(expected.length)} files? [y/N] `,
      ]);
      for (const file of expected) {
        expect(await readFile(path.join(cwd, file.path), 'utf8'), file.path).toBe(file.contents);
      }
      const written = run.stdout.split('\n').filter((line) => line.startsWith('wrote '));
      expect(written).toEqual([
        ...expected.map((file) => `wrote ${file.path}`),
        'wrote .gitignore',
      ]);
      expect(run.stderr).toMatch(/aw dev reads .+ from its environment; no key is written/u);
      expect(run.stderr).toMatch(/next: npx aw dev\n.*pushing with it is not supported yet\)\n$/u);
    },
  );

  it('on a terminal, theme knowledge writes the three starter files', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, [], { isTty: true, prompt: themeTerminal('knowledge').prompt });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    for (const file of ['agent-workspace.yaml', 'agents/knowledge.ts', 'surfaces/main.ts']) {
      expect(existsSync(path.join(cwd, file)), file).toBe(true);
    }
  });

  it('--yes asks nothing, even on a terminal that can prompt', async () => {
    const cwd = await emptyProject();
    const prompt = vi.fn<(question: string) => Promise<string>>();
    const run = await init(cwd, ['--yes'], { isTty: true, prompt });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(prompt).not.toHaveBeenCalled();
    for (const file of golden(cwd)) {
      expect(await readFile(path.join(cwd, file.path), 'utf8')).toBe(file.contents);
    }
  });

  it('on a terminal, refuses over an existing file after the answers, and writes nothing', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'agent-workspace.yaml'), 'mine\n');
    const terminal = themeTerminal('');
    const run = await init(cwd, [], { isTty: true, prompt: terminal.prompt });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('aw init would overwrite existing files:\n  agent-workspace.yaml');
    expect(terminal.questions.length).toBeGreaterThan(0);
    expect(terminal.questions.some((question) => question.endsWith('[y/N] '))).toBe(false);
    expect(existsSync(path.join(cwd, 'agents'))).toBe(false);
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toBe('mine\n');
  });

  it('names only the missing packages, and never changes package.json', async () => {
    const cwd = await emptyProject();
    const manifest = `{\n  "name": "mine",\n  "dependencies": { "@indx-workspace/sdk": "${AW_VERSION}" },\n  "devDependencies": { "@indx-workspace/aw": "${AW_VERSION}" }\n}\n`;
    await writeFile(path.join(cwd, 'package.json'), manifest);
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.stderr).toBe(
      `next: npm install -D @indx-workspace/embedded@${AW_VERSION} ${DEFAULT_ENGINE_SPECS}\n${CLOSING}`,
    );
    expect(await readFile(path.join(cwd, 'package.json'), 'utf8')).toBe(manifest);
  });

  it("names the chosen engine's packages, and no other engine's", async () => {
    const cwd = await emptyProject();
    const listed = Object.fromEntries(ALL_PINS.slice(0, 3));
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: listed }));
    const run = await init(cwd, ['--yes', '--engine', 'pi']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    const piSpecs = Object.entries(ENGINE_PACKAGES.pi).map(
      ([name, version]) => `${name}@${version}`,
    );
    expect(run.stderr).toBe(`next: npm install -D ${piSpecs.join(' ')}\n${CLOSING}`);
  });

  it('prints no install line when every package is listed', async () => {
    const cwd = await emptyProject();
    const dependencies = Object.fromEntries(ALL_PINS);
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies }));
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.stderr).toBe(CLOSING);
  });

  it.each(['agents', 'surfaces'])(
    'refuses when %s is a file, listing it, and writes nothing',
    async (parent) => {
      const cwd = await emptyProject();
      await writeFile(path.join(cwd, parent), 'mine\n');
      const run = await init(cwd, ['--yes']);
      expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain('aw init would overwrite existing files:');
      expect(run.stderr).toContain(`  ${parent}`);
      expect(run.stderr).not.toContain('unexpected');
      expect(run.stdout).toBe('');
      expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);
      expect(await readFile(path.join(cwd, parent), 'utf8')).toBe('mine\n');
    },
  );

  it('still succeeds, naming every package, when package.json cannot be read', async () => {
    const cwd = await emptyProject();
    await mkdir(path.join(cwd, 'package.json'));
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.stderr).toBe(`next: npm install -D ${ALL_SPECS}\n${CLOSING}`);
  });

  it('reads a package.json that starts with a byte-order mark', async () => {
    const cwd = await emptyProject();
    const dependencies = Object.fromEntries(
      ALL_PINS.map(([name, version]) => [name, `^${version}`]),
    );
    await writeFile(path.join(cwd, 'package.json'), `\uFEFF${JSON.stringify({ dependencies })}`);
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.stderr).toBe(CLOSING);
  });

  it("names a package listed at a version other than aw's", async () => {
    const cwd = await emptyProject();
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@indx-workspace/aw': '0.0.1',
          '@indx-workspace/embedded': 'latest',
          '@indx-workspace/sdk': 'workspace:*',
        },
      }),
    );
    const run = await init(cwd, ['--yes']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.stderr).toBe(
      `next: npm install -D @indx-workspace/aw@${AW_VERSION} @indx-workspace/embedded@${AW_VERSION} ${DEFAULT_ENGINE_SPECS}\n${CLOSING}`,
    );
  });

  it('refuses a control plane flag by name', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--url', 'https://aw.example.com']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('aw init does not take --url');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);
  });

  it('refuses a repeated --agent and writes nothing', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--agent', 'a', '--agent', 'b']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--agent was given more than once');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);
  });
});

describe('the files setup renders, through the loader (issue #543)', () => {
  it('loads the agent with its OpenAPI tool and the surface with its greeting', async () => {
    const root = await tempDirectory();
    temporary.push(root);
    const answers = withRecommendedAnswers({
      'content.internalTools': ['openapi'],
      'content.openapiDocument': 'apis/orders.openapi.json',
    });
    for (const file of renderProjectFiles(answers, { name: 'demo' })) {
      await tempFile(root, file.path, file.contents);
    }
    const result = await loadProject({ root, io: LOADER_IO, signal: new AbortController().signal });
    expect(result.problems).toEqual([]);
    expect(result.agents.map((agent) => agent.name)).toEqual(['assistant']);
    const [agent] = result.agents;
    expect(JSON.stringify(agent?.body.definition)).toContain('"orders"');
    expect(agent?.body.surfaces[0]?.parts?.greeting).toBe('Hi! How can I help you today?');
  });

  it('on a terminal with menus, asks choices as menus and confirms with a Yes-default menu', async () => {
    const cwd = await emptyProject();
    const menus: string[] = [];
    const initials: (readonly string[])[] = [];
    const typed: string[] = [];
    const run = await init(cwd, [], {
      isTty: true,
      prompt: (question) => {
        typed.push(question);
        return Promise.resolve('');
      },
      choose: (spec) => {
        menus.push(spec.title);
        initials.push(spec.initial);
        return Promise.resolve(spec.initial);
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(menus[0]).toBe(THEME_PROMPT);
    expect(menus.at(-1)).toBe('Write these 7 files?');
    expect(initials.at(-1)).toStrictEqual(['yes']);
    expect(typed.some((question) => question.endsWith('[y/N] '))).toBe(false);
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(true);
  });

  it('declines when the confirmation menu answers no', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, [], {
      isTty: true,
      prompt: () => Promise.resolve(''),
      choose: (spec) => Promise.resolve(spec.title.startsWith('Write') ? ['no'] : spec.initial),
    });
    expect(run.stderr).toBe('nothing written\n');
    expect(existsSync(path.join(cwd, 'agent-workspace.yaml'))).toBe(false);
  });
});

describe('aw init --yes with a provider that needs an endpoint (#879)', () => {
  it.each(['openai-compatible', 'azure-openai'])(
    'exits 2 naming --model-base-url for %s, and writes nothing',
    async (provider) => {
      const cwd = await emptyProject();
      const run = await init(cwd, ['--yes', '--provider', provider]);
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('--model-base-url');
      expect(run.stderr).toContain('fix: add --model-base-url <url>');
      expect(await readdir(cwd)).toEqual([]);
    },
  );

  it('writes the project once the endpoint is given', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, [
      '--yes',
      '--provider',
      'openai-compatible',
      '--model-base-url',
      'https://models.example.com/v1',
    ]);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8')).toContain(
      'https://models.example.com/v1',
    );
  });
});

describe('aw init --answers (#879)', () => {
  const ANSWERS = [
    'setup.theme: copilot',
    'admin.modelProvider: openai-compatible',
    'admin.modelBaseUrl: https://models.example.com/v1',
    'content.internalTools:',
    '  - openapi',
    'content.openapiDocument: apis/orders.json',
    'embedder.brandColour: "#0f6b77"',
    '',
  ].join('\n');
  const EQUIVALENT_FLAGS = [
    '--theme',
    'copilot',
    '--provider',
    'openai-compatible',
    '--model-base-url',
    'https://models.example.com/v1',
    '--tools',
    'openapi',
    '--openapi',
    'apis/orders.json',
    '--color',
    '#0f6b77',
  ];

  async function written(cwd: string): Promise<Record<string, string>> {
    const files = await readdir(cwd, { recursive: true, withFileTypes: true });
    const entries = await Promise.all(
      files
        .filter((entry) => entry.isFile() && entry.name !== 'answers.yaml')
        .map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [path.relative(cwd, file), await readFile(file, 'utf8')] as const;
        }),
    );
    return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
  }

  it('writes the same files as the equivalent flags', async () => {
    const withFile = await emptyProject();
    await writeFile(path.join(withFile, 'answers.yaml'), ANSWERS);
    const fromFile = await init(withFile, ['--yes', '--answers', 'answers.yaml']);
    expect(fromFile.code, fromFile.stderr).toBe(EXIT_CODE.ok);
    const withFlags = await emptyProject();
    const fromFlags = await init(withFlags, ['--yes', ...EQUIVALENT_FLAGS]);
    expect(fromFlags.code, fromFlags.stderr).toBe(EXIT_CODE.ok);
    expect(await written(withFile)).toEqual(await written(withFlags));
  });

  it('reads JSON too, and lets a flag win over the file', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'answers.json'), '{"content.agentName": "from-file"}');
    const run = await init(cwd, ['--yes', '--answers', 'answers.json', '--agent', 'from-flag']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(existsSync(path.join(cwd, 'agents/from-flag.ts'))).toBe(true);
    expect(existsSync(path.join(cwd, 'agents/from-file.ts'))).toBe(false);
  });

  it.each([
    ['an unknown key', 'content.engin: x\n', /content\.engin/u],
    ['a bad value', 'content.engine: nope\n', /content\.engine/u],
    [
      'a conditional answer that does not apply',
      'admin.modelBaseUrl: https://x.example\n',
      /admin\.modelBaseUrl: is asked only when/u,
    ],
    ['a file that is not an object', '- a\n', /object keyed by setup question id/u],
  ])('exits 2 naming the problem for %s, and writes nothing', async (_name, text, message) => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'answers.yaml'), text);
    const run = await init(cwd, ['--yes', '--answers', 'answers.yaml']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toMatch(message);
    expect(run.stderr).toContain('answers.yaml');
    expect(await readdir(cwd)).toEqual(['answers.yaml']);
  });

  it('exits 2 naming a file that does not exist', async () => {
    const cwd = await emptyProject();
    const run = await init(cwd, ['--yes', '--answers', 'missing.yaml']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--answers missing.yaml: the file does not exist');
  });

  it('still needs --yes (or a terminal) to write: the file answers, it does not confirm', async () => {
    const cwd = await emptyProject();
    await writeFile(path.join(cwd, 'answers.yaml'), 'setup.theme: blank\n');
    const run = await init(cwd, ['--answers', 'answers.yaml']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('fix: aw init --yes');
  });
});
