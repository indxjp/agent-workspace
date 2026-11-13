import type { EngineFrame } from '@agent-workspace/engine';
import { expect, it } from 'vitest';

import { preloadMastra } from './boundary.js';
import {
  GATEWAY,
  TOKEN,
  chatCompletion,
  drain,
  request,
  responsesText,
  scriptedGateway,
  sse,
  text,
  workspace,
} from './boundary.test-support.js';
import { createMastraEngine } from './engine.js';

const schema = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};

async function runWith(
  answer: string,
  outputSchema: Record<string, unknown> | undefined,
): Promise<{ frames: EngineFrame[]; failure: unknown }> {
  scriptedGateway.script = [text(answer)];
  const frames: EngineFrame[] = [];
  const failure = await (async () => {
    const connection = createMastraEngine().start(
      request(workspace(), outputSchema === undefined ? {} : { outputSchema }),
    );
    for await (const frame of connection.frames) frames.push(frame);
  })().then(
    () => null,
    (error: unknown) => error,
  );
  return { frames, failure };
}

it("sends the schema in the provider's response format", async () => {
  await runWith('{"verdict":"ok"}', schema);
  const format = (
    scriptedGateway.seen[0]?.body as { output_config?: { format?: Record<string, unknown> } }
  ).output_config?.format;
  expect(format).toMatchObject({
    type: 'json_schema',
    schema: { type: 'object', properties: { verdict: { type: 'string' } } },
  });
});

it('reports the text and the parsed object on agent.result for a matching answer', async () => {
  const { frames, failure } = await runWith('{"verdict":"ok"}', schema);
  expect(failure).toBeNull();
  expect(frames.at(-1)).toMatchObject({
    frame: 'agent.result',
    stopReason: 'end_turn',
    output: { text: '{"verdict":"ok"}', structured: { verdict: 'ok' } },
  });
});

it.each([
  ['an answer that does not match the schema', '{"verdict":5}'],
  ['an answer that is not JSON', 'not json'],
  ['an empty answer', ''],
] as const)(
  'fails with output_schema_unsatisfied, leaking neither schema nor answer, for %s',
  async (_name, answer) => {
    const { frames, failure } = await runWith(answer, schema);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/^output_schema_unsatisfied: /u);
    expect(message).not.toContain('verdict');
    if (answer !== '') expect(message).not.toContain(answer);
    const results = frames.filter((frame) => frame.frame === 'agent.result');
    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty('output');
    expect(scriptedGateway.seen).toHaveLength(1);
  },
);

it.each([
  [
    'openai-responses',
    responsesText,
    (body: unknown) => (body as { text?: { format?: unknown } }).text?.format,
  ],
  [
    'openai-chat-completions',
    chatCompletion,
    (body: unknown) => (body as { response_format?: unknown }).response_format,
  ],
] as const)(
  'sends the schema and refuses a mismatched answer by name on the %s route',
  async (protocol, answer, format) => {
    const gateway = { baseUrl: GATEWAY, token: TOKEN, protocol } as const;
    scriptedGateway.script = [answer('{"verdict":"ok"}')];
    const matched = await drain(
      createMastraEngine().start(request(workspace(), { gateway, outputSchema: schema })).frames,
    );
    expect(JSON.stringify(format(scriptedGateway.seen[0]?.body))).toContain('"verdict"');
    expect(matched.at(-1)).toMatchObject({
      frame: 'agent.result',
      output: { structured: { verdict: 'ok' } },
    });

    scriptedGateway.seen.length = 0;
    scriptedGateway.script = [answer('{"verdict":5}')];
    const failure = await drain(
      createMastraEngine().start(request(workspace(), { gateway, outputSchema: schema })).frames,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/^output_schema_unsatisfied: /u);
    expect(message).not.toContain('verdict');
    expect(message).not.toContain('{"verdict":5}');
    expect(scriptedGateway.seen).toHaveLength(1);
  },
);

it('leaves a malformed provider chunk as a plain failed run, not output_schema_unsatisfied', async () => {
  // The AI SDK raises `AI_TypeValidationError` for a chunk off its wire schema, as it does for
  // some answer failures; this one is the provider, so it must not be reported as the answer.
  scriptedGateway.script = [sse([{ type: 'response.created', response: { id: 'resp_1' } }])];
  const frames = await drain(
    createMastraEngine().start(
      request(workspace(), {
        gateway: { baseUrl: GATEWAY, token: TOKEN, protocol: 'openai-responses' },
        outputSchema: schema,
      }),
    ).frames,
  );
  expect(frames.filter((frame) => frame.frame === 'agent.result')).toMatchObject([
    { stopReason: 'error' },
  ]);
});

it('sends no response format and reports a null structured answer without a schema', async () => {
  const { frames, failure } = await runWith('plain words', undefined);
  expect(failure).toBeNull();
  expect(scriptedGateway.seen[0]?.body).not.toHaveProperty('output_config');
  expect(frames.at(-1)).toMatchObject({
    frame: 'agent.result',
    output: { text: 'plain words', structured: null },
  });
});

it('turns Mastra telemetry and its catalogue refresh off in the process before Mastra loads', async () => {
  await preloadMastra();
  expect(process.env['MASTRA_TELEMETRY_DISABLED']).toBe('1');
  expect(process.env['MASTRA_OFFLINE']).toBe('1');
});
