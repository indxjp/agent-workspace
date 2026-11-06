import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BuilderToolName } from '@indx-workspace/contracts/builder';
import {
  ScriptedModelScriptSchema,
  type ScriptedModelScript,
} from '@indx-workspace/contracts/models';
import { vi } from 'vitest';
import { draftBody } from '../../adapters/checker/checker.contract';
import { ORDER_CASE } from '../../adapters/runner/runner.contract';
import { TOOL_PREFIX, type Transcript, type Door } from './harness-contract';

/** Writes `script` as the scripted model `name` and points the gateway's provider at it. */
export async function scriptedModel(name: string, script: ScriptedModelScript): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'builder-scripted-'));
  await writeFile(path.join(dir, `${name}.json`), JSON.stringify(script));
  vi.stubEnv('AW_SCRIPTED_MODELS_DIR', dir);
  return `scripted:${name}`;
}

/** In a checked-in script, `"@draft:a,b"` stands for a valid draft body naming connectors a and b. */
const DRAFT_MARK = '@draft:';

/** Replays `<directory>/<name>.json` as the scripted model `name`, with its draft marks expanded. */
export async function scriptedModelFile(directory: string, name: string): Promise<string> {
  const text = await readFile(path.join(directory, `${name}.json`), 'utf8');
  const script = JSON.parse(text, (_key, value: unknown) =>
    typeof value === 'string' && value.startsWith(DRAFT_MARK)
      ? draftBody('Order desk', value.slice(DRAFT_MARK.length).split(',').filter(Boolean))
      : value,
  ) as unknown;
  return scriptedModel(name, ScriptedModelScriptSchema.parse(script));
}

/** The parsed tool results of a transcript, in the order the model asked for them. */
export function toolResults(transcript: Transcript): unknown[] {
  return transcript.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; content?: string }[])
          .filter((block) => block.type === 'tool_result')
          .map((block) => JSON.parse(block.content ?? 'null') as unknown)
      : [],
  );
}

/** A run the person approved `tool(input)` for: it pauses, the person approves, the continuation runs. */
export async function approvedFor(
  door: Door,
  tool: BuilderToolName,
  input: Record<string, unknown>,
) {
  const script = { turns: [{ toolUses: [toolUse(tool, input)] }, { text: 'Done.' }] };
  const model = await scriptedModel(`builder-approved-${randomUUID()}`, script);
  const paused = await door.start({ role: 'builder' }, model);
  await door.runScripted(paused.token, model, { gated: true });
  const decided = await door.decide(paused.runId, 'approve');
  return door.start({ role: 'builder' }, model, decided.runId);
}

/** The three approval-gated tools, and an input each accepts. */
export type GatedTool = 'draft_save' | 'trial_run' | 'evals_run';

export const gatedInputs = ({ agentId, version }: { agentId: string; version: number }) => ({
  draft_save: { body: draftBody('Refund desk', ['crm']) },
  trial_run: { agentId, version, input: 'Where is order 1042?' },
  evals_run: { agentId, version, cases: [ORDER_CASE] },
});

/** The `aw-control` tool use the engine's MCP client sends for `tool`. */
export function toolUse(tool: BuilderToolName, input: Record<string, unknown>) {
  return { name: `${TOOL_PREFIX}${tool}`, input };
}
