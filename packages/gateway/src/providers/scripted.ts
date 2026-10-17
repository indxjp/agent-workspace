/**
 * Scripted models: a TEST TOOL that replays a file of assistant turns instead of calling a
 * provider, so an `aw eval` or `aw chat` run is offline and deterministic.
 *
 * Selection is a reserved model id (`scripted:<name>`) on an Anthropic-family connection, and the
 * feature only exists when the process opts in with `AW_SCRIPTED_MODELS_DIR` in the `local`
 * deployment posture; any other posture with the variable set refuses to start. The gateway keeps
 * no per-run state: the turn to answer with is the number of assistant messages already in the
 * conversation, so a tool call followed by its result advances to the next turn.
 */
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { readDeploymentPosture } from '@agent-workspace/core/posture';
import {
  SCRIPTED_MODEL_NAME_PATTERN,
  SCRIPTED_MODEL_PREFIX,
  ScriptedModelScriptSchema,
  type ScriptedModelScript,
} from '@indx-workspace/contracts/models';

import type {
  AnthropicCountTokensRequest,
  AnthropicMessageRequest,
  ModelInfo,
  RequestContext,
} from '../types.js';

const SCRIPTED_MODELS_DIR_ENV = 'AW_SCRIPTED_MODELS_DIR';

export type ScriptedModels = {
  isScripted(model: string): boolean;
  listModels(): Promise<ModelInfo[]>;
  createMessage(request: AnthropicMessageRequest, context: RequestContext): Promise<Response>;
  countTokens(request: AnthropicCountTokensRequest): Promise<{ input_tokens: number }>;
};

const SCRIPT_SUFFIX = '.json';
const COUNT_TOKENS_ESTIMATE = 1;
const MODEL_CREATED_AT = '2026-01-01T00:00:00Z';

function scriptName(model: string): string | null {
  if (!model.startsWith(SCRIPTED_MODEL_PREFIX)) return null;
  return model.slice(SCRIPTED_MODEL_PREFIX.length);
}

function refusal(message: string, context: RequestContext): Response {
  return Response.json(
    {
      type: 'error',
      error: { type: 'invalid_request_error', message },
      request_id: context.requestId,
    },
    { status: 400 },
  );
}

function assistantTurns(request: AnthropicMessageRequest): number {
  const { messages } = request;
  if (!Array.isArray(messages)) return 0;
  return messages.filter(
    (message: unknown) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { role?: unknown }).role === 'assistant',
  ).length;
}

type Turn = ScriptedModelScript['turns'][number];
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

function blocksOf(turn: Turn, index: number): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (turn.text !== undefined) blocks.push({ type: 'text', text: turn.text });
  (turn.toolUses ?? []).forEach((use, position) => {
    blocks.push({
      type: 'tool_use',
      id: `toolu_scripted_${String(index)}_${String(position)}`,
      name: use.name,
      input: { ...use.input },
    });
  });
  return blocks;
}

function outputTokens(blocks: readonly ContentBlock[]): number {
  const characters = blocks.reduce(
    (sum, block) =>
      sum + (block.type === 'text' ? block.text.length : JSON.stringify(block.input).length),
    0,
  );
  return Math.max(1, Math.ceil(characters / 4));
}

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

function reply(
  request: AnthropicMessageRequest,
  name: string,
  turn: Turn,
  index: number,
): Response {
  const blocks = blocksOf(turn, index);
  const stopReason = turn.toolUses === undefined ? 'end_turn' : 'tool_use';
  const usage = { input_tokens: 0, output_tokens: outputTokens(blocks) };
  const id = `msg_scripted_${name}_${String(index)}`;
  const message = {
    id,
    type: 'message',
    role: 'assistant',
    model: request.model,
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
  };
  if (request['stream'] !== true) return Response.json({ ...message, usage });

  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  ];
  blocks.forEach((block, position) => {
    if (block.type === 'text') {
      events.push(
        {
          type: 'content_block_start',
          index: position,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: position,
          delta: { type: 'text_delta', text: block.text },
        },
      );
    } else {
      events.push(
        {
          type: 'content_block_start',
          index: position,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
        {
          type: 'content_block_delta',
          index: position,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
      );
    }
    events.push({ type: 'content_block_stop', index: position });
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: 'message_stop' },
  );
  return sse(events);
}

export function createScriptedModels(options: { readonly dir: string }): ScriptedModels {
  const { dir } = options;

  async function load(name: string): Promise<ScriptedModelScript | null> {
    // The name is checked before any path is built, so it can never traverse out of `dir`.
    if (!SCRIPTED_MODEL_NAME_PATTERN.test(name)) return null;
    try {
      const raw: unknown = JSON.parse(await readFile(join(dir, `${name}${SCRIPT_SUFFIX}`), 'utf8'));
      const parsed = ScriptedModelScriptSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  return {
    isScripted: (model) => model.startsWith(SCRIPTED_MODEL_PREFIX),
    async listModels() {
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        return [];
      }
      return files
        .filter((file) => file.endsWith(SCRIPT_SUFFIX))
        .map((file) => file.slice(0, -SCRIPT_SUFFIX.length))
        .filter((name) => SCRIPTED_MODEL_NAME_PATTERN.test(name))
        .sort()
        .map((name) => ({
          id: `${SCRIPTED_MODEL_PREFIX}${name}`,
          type: 'model' as const,
          display_name: `Scripted: ${name}`,
          created_at: MODEL_CREATED_AT,
        }));
    },
    async createMessage(request, context) {
      const name = scriptName(request.model) ?? '';
      if (!SCRIPTED_MODEL_NAME_PATTERN.test(name)) {
        return refusal(
          `A scripted model id is "${SCRIPTED_MODEL_PREFIX}<name>" with a lowercase file-safe name.`,
          context,
        );
      }
      const script = await load(name);
      if (script === null) {
        return refusal(
          `Scripted model "${name}" has no valid script file (${name}${SCRIPT_SUFFIX}).`,
          context,
        );
      }
      const index = assistantTurns(request);
      const turn = script.turns[index];
      if (turn === undefined) {
        return refusal(
          `Scripted model "${name}" has ${String(script.turns.length)} turn(s) and the conversation asks for turn ${String(index + 1)}.`,
          context,
        );
      }
      return reply(request, name, turn, index);
    },
    countTokens: () => Promise.resolve({ input_tokens: COUNT_TOKENS_ESTIMATE }),
  };
}

/**
 * The scripted models the process opted into, or `undefined` when `AW_SCRIPTED_MODELS_DIR` is
 * unset (every deployment). A set variable that is relative, or that is set outside the `local`
 * posture, throws: the gateway and the web process then fail at startup instead of silently
 * serving a test tool.
 */
export function scriptedModelsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ScriptedModels | undefined {
  const dir = (env[SCRIPTED_MODELS_DIR_ENV] ?? '').trim();
  if (dir.length === 0) return undefined;
  if (!isAbsolute(dir)) {
    throw new Error(`${SCRIPTED_MODELS_DIR_ENV} must be an absolute path.`);
  }
  if (readDeploymentPosture(env) !== 'local') {
    throw new Error(
      `${SCRIPTED_MODELS_DIR_ENV} is a test tool and only works in the local posture.`,
    );
  }
  return createScriptedModels({ dir });
}
