import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { runCompatibilitySuite } from '../../../../tests/providers/harness.js';
import { anthropicToOpenAI, openAIError, openAIToAnthropic } from '../translate/openai.js';
import {
  OPENAI_APPROXIMATION_WARNINGS,
  OPENAI_CANNOT_REPRESENT,
  OPENAI_TRANSLATION_TABLE,
} from '../translate/openai-translation-table.js';
import { createOpenAIProvider } from './openai.js';
import {
  fixtureContext,
  fixtureServerStarter,
  responseBody,
  TEXT_CALL_REASONING_OUTPUT,
  WEATHER_ANTHROPIC_REQUEST,
} from './openai.test-support.js';

const startFixtureServer = fixtureServerStarter();

describe('OpenAI Responses provider', () => {
  it('passes all ten required §41 scenarios against the recorded-fixture endpoint', async () => {
    const fixture = await startFixtureServer();
    const report = await runCompatibilitySuite(createOpenAIProvider({ baseUrl: fixture.url }));

    expect(report.outcomes.slice(0, 10).map((outcome) => outcome.verdict)).toEqual(
      Array.from({ length: 10 }, () => 'native'),
    );
    expect(report.ok).toBe(true);
  });

  it('takes credentials only from RequestContext and sends the translated request', async () => {
    const fixture = await startFixtureServer();
    const provider = createOpenAIProvider({ baseUrl: fixture.url });
    const response = await provider.createMessage(
      { model: 'gpt-fixture', messages: [{ role: 'user', content: 'Hi' }] },
      fixtureContext(),
    );

    expect(response.ok).toBe(true);
    expect(fixture.requests[0]).toMatchObject({
      model: 'gpt-fixture',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
    });
    const source = await readFile(new URL('./openai.ts', import.meta.url), 'utf8');
    expect(source).not.toContain(['process', 'env'].join('.'));
  });

  it('refuses a base URL that resolves to an RFC1918 address (W9-PROV-127)', async () => {
    const provider = createOpenAIProvider({ baseUrl: 'https://10.0.0.5/v1' });
    await expect(
      provider.createMessage({ model: 'gpt-fixture', messages: [] }, fixtureContext()),
    ).rejects.toThrow(/Egress policy refused/);
  });
});

describe('OpenAI translation inventory', () => {
  it('derives the complete translation inventory from spec §11', async () => {
    const spec = await readFile(new URL('../../../../docs/spec.md', import.meta.url), 'utf8');
    const section = spec.slice(
      spec.indexOf('# 11. Anthropic'),
      spec.indexOf('# 12. Never Pretend'),
    );
    const elements = [...section.matchAll(/^\* (.+)$/gm)].map((match) => match[1]);

    expect(OPENAI_TRANSLATION_TABLE.map((row) => row.element)).toEqual(elements);
    expect(OPENAI_TRANSLATION_TABLE.every((row) => row.verdict.length > 0)).toBe(true);
    expect(OPENAI_CANNOT_REPRESENT).toHaveLength(7);
    expect(OPENAI_CANNOT_REPRESENT).toContain('tool_result.is_error');
  });

  it('uses every operator-facing approximation sentence verbatim from the R-04 fixture', async () => {
    const sentencesFile = 'R-04-operator-sentences.md';
    const note = await readFile(
      new URL(`../../../../docs/research/fixtures/${sentencesFile}`, import.meta.url),
      'utf8',
    );
    const documented = new Set(
      [...note.matchAll(/Operator sentence[^\n]*?\*"([^"]+)"\*/g)].map((match) => match[1]),
    );

    const warnings = Object.values(OPENAI_APPROXIMATION_WARNINGS);
    expect(warnings.every((warning) => warning.trim().endsWith('.'))).toBe(true);
    expect(warnings.filter((warning) => !documented.has(warning))).toEqual([]);
  });
});

describe('OpenAI request and response round trip', () => {
  it('translates the representable §11 request elements', () => {
    const request = anthropicToOpenAI(WEATHER_ANTHROPIC_REQUEST);

    expect(request.instructions).toBe('Be concise.');
    expect(request.input).toContainEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'weather',
      arguments: '{"city":"Tokyo"}',
    });
    expect(request.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'sunny',
    });
    expect(request.tools?.[0]).toEqual({
      type: 'function',
      name: 'weather',
      description: 'Get weather',
      parameters: { type: 'object' },
      strict: false,
    });
    expect(request.stream).toBe(true);
    expect(request.reasoning).toEqual({ summary: 'auto' });
  });

  it('translates the representable §11 response elements', () => {
    const response = openAIToAnthropic(responseBody(TEXT_CALL_REASONING_OUTPUT), 'fallback');

    expect(response['stop_reason']).toBe('tool_use');
    expect(response['content']).toEqual([
      { type: 'text', text: 'Done' },
      { type: 'tool_use', id: 'call_2', name: 'weather', input: { city: 'Kyoto' } },
      { type: 'thinking', thinking: 'Checked conditions.', signature: 'opaque' },
    ]);
    expect(response['usage']).toMatchObject({
      input_tokens: 8,
      output_tokens: 2,
      cache_read_input_tokens: 3,
    });
    expect(openAIError(429, { error: { message: 'slow down' } }, 'req_1').status).toBe(429);
  });
});
