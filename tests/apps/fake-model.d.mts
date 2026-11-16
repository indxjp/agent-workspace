import type { IncomingMessage, ServerResponse } from 'node:http';

import type { FakeRequestRecord } from '../generated-project/fake-anthropic.mjs';

export type ScriptTurn =
  | { readonly tool: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly text: string }
  | { readonly structured: Readonly<Record<string, unknown>> };

export type ModelScript = {
  readonly conversations: readonly {
    readonly when: string;
    readonly turns: readonly ScriptTurn[];
  }[];
};

export type ScriptedAnswer =
  | { readonly toolUse: { readonly name: string; readonly input: Record<string, unknown> } }
  | { readonly text: string };

export type ScriptedRecord = { readonly answer: ScriptedAnswer; readonly toolNames: string[] };

export const FAKE_KEY_PREFIX: string;
export const STRUCTURED_OUTPUT_TOOL: string;
export function fakeModelKey(): string;
export function parseModelScript(value: unknown): ModelScript;
export function readModelScript(file: string): ModelScript;
export function scriptedTurn(
  script: ModelScript,
  messages: readonly unknown[],
): ScriptTurn | undefined;
export function offeredTool(
  tools: readonly { readonly name?: unknown }[],
  tool: string,
): string | undefined;
export function answerOf(
  turn: ScriptTurn,
  tools: readonly { readonly name?: unknown }[],
  messages?: readonly unknown[],
  when?: string,
): ScriptedAnswer | undefined;
export function createScriptedModelHandler(
  script: ModelScript,
  requests: FakeRequestRecord[],
  scripted?: ScriptedRecord[],
): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export function startFakeModel(script: ModelScript): Promise<{
  baseUrl: string;
  key: string;
  requests: FakeRequestRecord[];
  scripted: ScriptedRecord[];
  close: () => Promise<void>;
}>;
