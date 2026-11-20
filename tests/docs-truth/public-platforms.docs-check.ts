/**
 * The platform guides (chapter 7) and the runtime and sandbox claims of the public docs follow
 * what main does.
 *
 * A static check of the `docs-check` lane (tests/static-checks/vitest.config.ts).
 */
import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readPlatformPage, readSitePage, repository } from './docs-truth.test-support.js';

const sitePages = new URL('docs/sdk/site/', repository);
const platformDirectory = new URL('platforms/', sitePages);

const platformPages = async () => {
  const pages = (await readdir(platformDirectory)).filter((page) => page.endsWith('.mdx'));
  return Promise.all(
    pages.map(async (page) => ({
      page,
      text: await readFile(new URL(page, platformDirectory), 'utf8'),
    })),
  );
};

async function expectPublishSection(page: string, platform: string, tokenCommand: string) {
  const text = await readPlatformPage(page);
  expect(text).toContain('## Publish ```sh');
  expect(text).toContain(`aw platforms publish --platform ${platform} --yes`);
  expect(text).toContain(tokenCommand);
  expect(text).toContain('unverified against a live tenant');
  expect(text).not.toContain('not yet available');
}

describe('runtime and sandbox claims follow what main does', () => {
  // Issue #787: docs truth sweep.
  it('states what runs, engines, agent writes and the sandbox-runtime driver do today', async () => {
    expect(await readSitePage('guides/evaluations.mdx')).toContain('node-version: 24');
    expect(await readSitePage('resources/observability.mdx')).toContain(
      '`aw runs events <run-id>`',
    );
    expect(await readSitePage('path/test.mdx')).toContain('with `aw runs events`');
    const runsPage = await readSitePage('resources/runs.mdx');
    expect(runsPage).not.toContain('on every run this release starts');
    expect(runsPage).toContain("`'claude-agent-sdk' | 'openai-agents' | 'pi' | 'mastra'`");
    const runtimes = await readSitePage('building/models-and-runtimes.mdx');
    expect(runtimes).not.toContain('gVisor-free');
    expect(runtimes).not.toContain('`sandbox-runtime.ts`');
    for (const page of [
      'path/build.mdx',
      'guides/agents-as-code.mdx',
      'features/agents-skills-tools-as-code.mdx',
      'features/run-observe-evaluate.mdx',
    ]) {
      const text = await readSitePage(page);
      expect(text, page).not.toMatch(/browser edits are not versioned/iu);
      expect(text, page).not.toMatch(/\baw agents update\b[^.]*\bsave(?:s)? no version/iu);
    }
  });

  // Issue #818: the id is accepted in contracts and old project files, but it has no implementation.
  it('never claims the sandbox-runtime driver is implemented or needs a sandbox tool', async () => {
    const pages = (await readdir(sitePages, { recursive: true })).filter(
      (page) => page.endsWith('.mdx') && !page.startsWith('reference'),
    );
    const unimplemented = /not implemented|no implementation|reserved|without a driver/iu;
    let mentions = 0;
    for (const page of pages) {
      const text = (await readFile(new URL(page, sitePages), 'utf8')).replace(
        /^```[^]*?^```/gmu,
        '',
      );
      expect(text, page).not.toMatch(/bubblewrap|bwrap/iu);
      // A table row is one claim; prose is a paragraph.
      for (const block of text.split(/\n\s*\n|\n(?=\|)/u)) {
        if (!block.includes('sandbox-runtime')) continue;
        mentions += 1;
        const claim = block.replace(/\s+/gu, ' ');
        expect(claim, `${page}: ${claim}`).toMatch(unimplemented);
        expect(claim, `${page}: ${claim}`).not.toMatch(/\|\s*Implemented/u);
      }
    }
    expect(mentions).toBeGreaterThan(0);
  });
});

describe('chapter 7 describes publish only where an executor exists', () => {
  // Issue #978: chapter 7 describes publish only where an executor exists on main.
  it('claims publish for every platform that has an executor', async () => {
    await expectPublishSection(
      'microsoft-foundry.mdx',
      'microsoft-foundry',
      'az account get-access-token',
    );
    await expectPublishSection(
      'gemini-enterprise.mdx',
      'gemini-enterprise',
      'gcloud auth print-access-token',
    );
    const managedAgents = await readPlatformPage('claude-managed-agents.mdx');
    expect(managedAgents).toContain('subagents_unsupported');
    expect(managedAgents).toContain('unverified against a live tenant');
    expect(managedAgents).not.toMatch(/live lane[^.]*\b(passed|verified|green)\b/iu);
    const executors = {
      'claude-managed-agents.mdx': 'ant apply',
      'copilot-studio.mdx': 'pac solution',
      'm365-declarative-agent.mdx': 'atk provision',
      'aws-agentcore.mdx': 'agentcore deploy',
    };
    for (const [page, command] of Object.entries(executors)) {
      expect(await readPlatformPage(page), page).toContain(command);
    }
    expect(await readPlatformPage('eject.mdx')).toContain(
      '`aw platforms publish` refuses an eject target',
    );
  });

  it('lists chapter 7 in the navigation after the last required chapter', async () => {
    const docs = JSON.parse(await readFile(new URL('docs.json', sitePages), 'utf8')) as unknown;
    const groups = JSON.stringify(docs);
    expect(groups).toMatch(/"group":"7 · Run it on other platforms","pages":\["path\/platforms"/u);
    const operate = await readFile(new URL('path/operate.mdx', sitePages), 'utf8');
    expect(operate).not.toContain('This is the last chapter');
  });
});

describe('every platform guide keeps the decided shape', () => {
  it('names no retired target and no --target flag under platforms/', async () => {
    for (const { page, text } of await platformPages()) {
      // OpenAI Agent Builder shuts down on 2026-11-30.
      expect(text, page).not.toContain('Agent Builder');
      expect(text, page).not.toMatch(/--target\b/u);
    }
  });

  it('gives every platform guide the decided headings, in order', async () => {
    const headings = [
      'What you can do',
      'Before you start',
      'Export',
      'What maps and what is dropped',
      'Publish',
      'Your tools',
      'What is not there yet',
    ];
    const guides = [
      'claude-managed-agents.mdx',
      'copilot-studio.mdx',
      'm365-declarative-agent.mdx',
      'microsoft-foundry.mdx',
      'gemini-enterprise.mdx',
      'aws-agentcore.mdx',
    ];
    for (const guide of guides) {
      const text = await readFile(new URL(guide, platformDirectory), 'utf8');
      const found = [...text.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
      expect(found, guide).toEqual(headings);
      expect(text, guide).toContain('](/platforms/matrix)');
    }
  });

  it('labels vendor commands still marked VERIFY and gates the live Copilot push', async () => {
    for (const page of ['claude-managed-agents.mdx', 'copilot-studio.mdx', 'aws-agentcore.mdx']) {
      expect(await readPlatformPage(page), page).toContain('unverified against a live tenant');
    }
    const copilot = await readPlatformPage('copilot-studio.mdx');
    const live = copilot
      .split(/(?<=\.) /u)
      .filter((sentence) => sentence.includes('pac solution import'));
    expect(live.length).toBeGreaterThan(0);
    for (const sentence of live) expect(sentence).toContain('--experimental');
  });
});
