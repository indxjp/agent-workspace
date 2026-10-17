import { SETUP_QUESTIONS } from '@indx-workspace/contracts/setup';
import { describe, expect, it } from 'vitest';

import type { MenuSpec } from './choose.js';
import {
  askSetupQuestions,
  isInteractive,
  mergeSetupAnswers,
  parseSetupAnswersFile,
  parseSetupFlags,
  setupFlagsHelp,
  unansweredSetupRefusal,
} from './ask.js';
import { ProjectFileError } from './reader.js';

/** The journey's prompt shape: a question, the format in parentheses, the recommendation. */
const SETUP_PROMPT = /^[A-Z][^?]*\? \(.*\) \[[^\]]*\] $/u;

/** Answers `typed` in order, recording every prompt and every line said. */
async function scripted(typed: readonly string[]) {
  const queue = [...typed];
  const asked: string[] = [];
  const said: string[] = [];
  const answers = await askSetupQuestions(
    (question) => {
      asked.push(question);
      const next = queue.shift();
      if (next === undefined) throw new Error(`unscripted prompt: ${question}`);
      return Promise.resolve(next);
    },
    (line) => said.push(line),
  );
  expect(queue).toStrictEqual([]);
  return { answers, asked, said };
}

describe('askSetupQuestions', () => {
  it('answers a multi-select and asks the conditional question it opens', async () => {
    const { answers, asked } = await scripted([
      '', // theme
      '', // sandbox
      '', // model provider
      '', // agent name
      '', // engine
      'openapi',
      'apis/orders.openapi.json',
      'readFiles, runCommands',
      '', // title
      '', // colour
      '', // platforms
    ]);
    expect(answers['content.internalTools']).toStrictEqual(['openapi']);
    expect(answers['content.openapiDocument']).toBe('apis/orders.openapi.json');
    expect(answers['content.permissions']).toStrictEqual(['readFiles', 'runCommands']);
    expect(asked.every((prompt) => SETUP_PROMPT.test(prompt))).toBe(true);
  });

  it('skips a question whose when is false', async () => {
    const { answers, asked } = await scripted(Array<string>(10).fill(''));
    expect(asked.some((prompt) => prompt.startsWith('Where is the OpenAPI document?'))).toBe(false);
    expect(answers['content.internalTools']).toStrictEqual(['none']);
    expect('content.openapiDocument' in answers).toBe(false);
  });

  it('says why an answer is refused and asks the same question again', async () => {
    const { asked, said } = await scripted([
      '',
      '',
      '',
      '',
      '',
      'none,openapi',
      '', // tools again
      '',
      '',
      '',
      '',
    ]);
    expect(asked[6]).toBe(asked[5]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\["none","openapi"\] is not accepted: .*none must be chosen alone$/u);
  });

  it("recommends the chosen theme's answers", async () => {
    const { answers, asked } = await scripted(['copilot', ...Array<string>(9).fill('')]);
    expect(asked[3]).toMatch(/ \[copilot\] $/u);
    expect(answers['content.agentName']).toBe('copilot');
  });
});

describe('parseSetupFlags', () => {
  it('reads each flag with its question schema, multi answers comma-separated', () => {
    expect(
      parseSetupFlags({ provider: 'openai', color: '#0f6b77', tools: 'openapi,postgres' }),
    ).toStrictEqual({
      'admin.modelProvider': 'openai',
      'embedder.brandColour': '#0f6b77',
      'content.internalTools': ['openapi', 'postgres'],
    });
  });

  it('refuses a bad value with the interview message, naming the flag', () => {
    expect(() => parseSetupFlags({ color: 'teal' })).toThrow(
      /^--color: "teal" is not accepted: a hex colour, # followed by six hex digits$/u,
    );
    expect(() => parseSetupFlags({ tools: 'none,openapi' })).toThrow(/none must be chosen alone/u);
    expect(() => parseSetupFlags({ openapi: 'a.json' })).toThrow(/^--openapi: is asked only when/u);
  });

  it('does not ask a question a flag answered', async () => {
    const asked: string[] = [];
    const answers = await askSetupQuestions(
      (question) => {
        asked.push(question);
        return Promise.resolve('');
      },
      () => undefined,
      parseSetupFlags({ provider: 'openai' }),
    );
    expect(answers['admin.modelProvider']).toBe('openai');
    expect(asked).toHaveLength(9);
    expect(asked.some((question) => question.startsWith("Who serves the agent's model?"))).toBe(
      false,
    );
  });

  it('reads --model-base-url with a provider that needs one, and refuses it without', () => {
    expect(
      parseSetupFlags({
        provider: 'openai-compatible',
        'model-base-url': 'http://localhost:11434/v1',
      }),
    ).toMatchObject({ 'admin.modelBaseUrl': 'http://localhost:11434/v1' });
    expect(() =>
      parseSetupFlags({ provider: 'openai', 'model-base-url': 'https://x.example/' }),
    ).toThrow(
      '--model-base-url: is asked only when admin.modelProvider is anthropic-compatible or openai-compatible or azure-openai',
    );
  });

  it('reads --platform in the order given, and refuses an id setup does not offer', () => {
    expect(parseSetupFlags({ platform: 'copilot-studio,claude-managed-agents' })).toStrictEqual({
      'admin.platforms': ['copilot-studio', 'claude-managed-agents'],
    });
    expect(() => parseSetupFlags({ platform: 'eject-mastra' })).toThrow(
      '--platform: ["eject-mastra"] is not accepted: up to 6 of claude-managed-agents, copilot-studio, m365-declarative-agent, microsoft-foundry, gemini-enterprise, aws-agentcore, none, separated by commas',
    );
  });

  it('lists every flag in the help', () => {
    expect(setupFlagsHelp()).toHaveLength(12);
    expect(setupFlagsHelp()[2]).toContain('--provider <');
    expect(setupFlagsHelp()[3]).toContain('--model-base-url <');
    // BH061-044: the endpoint has no default to take, so its help does not claim one.
    expect(setupFlagsHelp()[3]).toContain(
      '(required when --provider is anthropic-compatible or openai-compatible or azure-openai; no default)',
    );
    expect(setupFlagsHelp()[3]).not.toContain('default: https://');
  });
});

describe('askSetupQuestions with a menu', () => {
  it('asks every choice and multi question as a menu with the recommendation preselected, and types the rest', async () => {
    const menus: MenuSpec[] = [];
    const typed: string[] = [];
    const answers = await askSetupQuestions(
      (question) => {
        typed.push(question);
        return Promise.resolve('');
      },
      () => undefined,
      {},
      (spec) => {
        menus.push(spec);
        return Promise.resolve(spec.title.startsWith('Which theme') ? ['review'] : spec.initial);
      },
    );
    expect(answers['setup.theme']).toBe('review');
    expect(menus[0]?.options.find((option) => option.value === 'review')?.hint).toMatch(/review/iu);
    expect(menus.find((spec) => spec.max !== undefined)?.max).toBeGreaterThan(0);
    // the second question is the sandbox: its menu preselects that question's own recommendation
    const sandbox = SETUP_QUESTIONS[1];
    expect(menus[1]?.title).toBe(sandbox?.prompt);
    expect(menus[1]?.initial).toStrictEqual([sandbox?.recommended]);
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.every((question) => SETUP_PROMPT.test(question))).toBe(true);
  });

  it('asks again when a menu answer is refused', async () => {
    let calls = 0;
    const said: string[] = [];
    await askSetupQuestions(
      () => Promise.resolve(''),
      (line) => said.push(line),
      {},
      (spec) => {
        calls += 1;
        return Promise.resolve(
          spec.max !== undefined && calls < 12 && said.length === 0
            ? ['none', 'openapi']
            : spec.initial,
        );
      },
    );
    expect(said.some((line) => line.includes('none must be chosen alone'))).toBe(true);
  });
});

describe('isInteractive', () => {
  const facts = (stdinIsTty: boolean, stdoutIsTty: boolean, ci?: string) => ({
    stdinIsTty,
    stdoutIsTty,
    env: ci === undefined ? {} : { CI: ci },
  });

  it('is true only with both streams on a terminal and CI unset', () => {
    expect(isInteractive(facts(true, true))).toBe(true);
    expect(isInteractive(facts(false, true))).toBe(false);
    expect(isInteractive(facts(true, false))).toBe(false);
    expect(isInteractive(facts(false, false))).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes'])('is false on a terminal when CI=%s', (ci) => {
    expect(isInteractive(facts(true, true, ci))).toBe(false);
  });

  it.each(['', '0', 'false', 'False'])('stays true on a terminal when CI=%j', (ci) => {
    expect(isInteractive(facts(true, true, ci))).toBe(true);
  });
});

describe('parseSetupAnswersFile', () => {
  const yaml = 'content.engine: claude-agent-sdk\ncontent.internalTools:\n  - openapi\n';
  const json = '{"content.engine": "claude-agent-sdk", "content.internalTools": ["openapi"]}';

  it('reads YAML and JSON to the same answers', () => {
    expect(parseSetupAnswersFile(yaml, 'a.yaml')).toStrictEqual(
      parseSetupAnswersFile(json, 'a.json'),
    );
    expect(parseSetupAnswersFile(yaml, 'a.yaml')['content.internalTools']).toStrictEqual([
      'openapi',
    ]);
  });

  it('names an unknown key and its file', () => {
    expect(() => parseSetupAnswersFile('content.engin: x\n', 'answers.yaml')).toThrow(
      /answers\.yaml line 1, column 1: "content\.engin" is not a setup question id/u,
    );
    // BH061-041: the refusal lists the ids, so they are discoverable from the error.
    expect(() => parseSetupAnswersFile('content.engin: x\n', 'answers.yaml')).toThrow(
      /one of .*setup\.theme/u,
    );
  });

  it('names the key and line of a value that is not accepted', () => {
    const text = 'setup.theme: blank\ncontent.engine: nope\n';
    expect(() => parseSetupAnswersFile(text, 'answers.yaml')).toThrow(
      /answers\.yaml line 2, column 1: content\.engine: /u,
    );
  });

  it('names a conditional answer whose question does not apply', () => {
    expect(() =>
      parseSetupAnswersFile('admin.modelBaseUrl: https://x.example\n', 'a.yaml'),
    ).toThrow(/admin\.modelBaseUrl: is asked only when/u);
  });

  it.each(['', '- a\n', 'just text\n'])('refuses %j, which is not an object', (text) => {
    expect(() => parseSetupAnswersFile(text, 'a.yaml')).toThrow(ProjectFileError);
  });

  it('refuses a duplicate key rather than picking one', () => {
    expect(() =>
      parseSetupAnswersFile('setup.theme: blank\nsetup.theme: copilot\n', 'a.yaml'),
    ).toThrow(/duplicate key/u);
  });
});

describe('mergeSetupAnswers', () => {
  it('lets a flag win over the file', () => {
    const merged = mergeSetupAnswers(
      { 'content.engine': 'claude-agent-sdk', 'setup.theme': 'blank' },
      { 'setup.theme': 'copilot' },
    );
    expect(merged['setup.theme']).toBe('copilot');
    expect(merged['content.engine']).toBe('claude-agent-sdk');
  });

  it('checks a conditional answer against the other source', () => {
    expect(() =>
      mergeSetupAnswers(
        { 'admin.modelBaseUrl': 'https://x.example/' },
        { 'admin.modelProvider': 'anthropic' },
      ),
    ).toThrow(/admin\.modelBaseUrl: is asked only when/u);
    expect(
      mergeSetupAnswers(
        { 'admin.modelBaseUrl': 'https://x.example/' },
        { 'admin.modelProvider': 'openai-compatible' },
      )['admin.modelBaseUrl'],
    ).toBe('https://x.example/');
  });
});

describe('unansweredSetupRefusal', () => {
  it('names the missing flag and the fix for an endpoint provider without one', () => {
    expect(unansweredSetupRefusal({ 'admin.modelProvider': 'openai-compatible' })).toStrictEqual({
      message: '--model-base-url is required here: it has no default and nothing can ask for it',
      fix: 'add --model-base-url <url>',
    });
  });

  it('is null when every answer can be taken', () => {
    expect(unansweredSetupRefusal({})).toBeNull();
    expect(
      unansweredSetupRefusal({
        'admin.modelProvider': 'openai-compatible',
        'admin.modelBaseUrl': 'https://models.example.com/v1',
      }),
    ).toBeNull();
  });
});
