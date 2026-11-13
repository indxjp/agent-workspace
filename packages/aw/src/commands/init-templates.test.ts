import { existsSync } from 'node:fs';

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';

import { ENGINE_PACKAGES, renderProjectFiles } from '@indx-workspace/sdk/project';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { loadProject } from '../project/load.js';

import { tempDirectory, tempFile } from '../testing.js';

import { AW_VERSION } from '../version.js';

import {
  ALL_PINS,
  ALL_SPECS,
  CLOSING,
  DEFAULT_ENGINE_SPECS,
  emptyProject,
  init,
  LOADER_IO,
  temporary,
  THEME_PROMPT,
} from './init.fixture.test-support.js';
describe('aw init (issue #451)', () => {
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
});
