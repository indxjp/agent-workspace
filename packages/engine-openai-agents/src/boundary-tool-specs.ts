/**
 * The function tools of the OpenAI Agents adapter as plain specs: a name, a description, a zod
 * parameter schema and an executor. `./boundary.ts` hands each to the SDK's `tool(…)`, so no SDK
 * type is named here (the SDK is imported by that one file only).
 */
import type { OpenAiAgentsToolName } from '@indx-workspace/contracts/agents';
import { z } from 'zod';

import {
  executeRunSkillScript,
  RUN_SKILL_SCRIPT_TOOL,
  skillScriptToolDescription,
  type ToolAnswers,
} from '@agent-workspace/engine';

import type { OpenAiAgentsCompiled } from './compile.js';
import {
  applyPatch,
  listWorkspaceFiles,
  readWorkspaceFile,
  runShell,
  searchWorkspaceFiles,
  type ApplyDiff,
  type PatchOperation,
} from './executors.js';
import { nodeSkillScriptHost, OPENAI_AGENTS_SKILL_SCRIPT_INPUT } from './skill-script.js';

/** What every compiled function tool runs against. */
export type ToolContext = {
  readonly workspace: OpenAiAgentsCompiled['workspace'];
  readonly env: OpenAiAgentsCompiled['env'];
  readonly signal: AbortSignal;
  /** The SDK's `applyDiff`, passed in because this file may not import the SDK. */
  readonly applyDiff: ApplyDiff;
};

type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodObject;
  readonly execute: (input: Record<string, unknown>) => Promise<string>;
};

function specOf<Parameters extends z.ZodObject>(definition: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Parameters;
  readonly execute: (input: z.output<Parameters>) => Promise<string>;
}): ToolSpec {
  return {
    ...definition,
    execute: (input) => definition.execute(definition.parameters.parse(input)),
  };
}

const PathParameters = z.object({ path: z.string() });

const PatchParameters = z.object({
  type: z.enum(['create_file', 'update_file', 'delete_file']),
  path: z.string(),
  diff: z.string().nullable(),
  moveTo: z.string().nullable(),
});

/** The `apply_patch` tool's input as the executor's operation; `null` fields become empty. */
function patchOperationOf(input: z.output<typeof PatchParameters>): PatchOperation {
  if (input.type === 'delete_file') return { type: 'delete_file', path: input.path };
  if (input.type === 'create_file') {
    return { type: 'create_file', path: input.path, diff: input.diff ?? '' };
  }
  return { type: 'update_file', path: input.path, diff: input.diff ?? '', moveTo: input.moveTo };
}

const WORKSPACE_TOOLS: Record<OpenAiAgentsToolName, (context: ToolContext) => ToolSpec> = {
  read_file: ({ workspace }) =>
    specOf({
      name: 'read_file',
      description: `Read one UTF-8 file. Paths are relative to ${workspace.cwd}.`,
      parameters: PathParameters,
      execute: ({ path }) => readWorkspaceFile(workspace, path),
    }),
  list_files: ({ workspace }) =>
    specOf({
      name: 'list_files',
      description: `List one directory. Paths are relative to ${workspace.cwd}; use "." for the root.`,
      parameters: PathParameters,
      execute: ({ path }) => listWorkspaceFiles(workspace, path),
    }),
  search_files: ({ workspace }) =>
    specOf({
      name: 'search_files',
      description: 'Find the lines containing a plain-text query in one file or under a directory.',
      parameters: z.object({ path: z.string(), query: z.string() }),
      execute: ({ path, query }) => searchWorkspaceFiles(workspace, path, query),
    }),
  apply_patch: ({ workspace, applyDiff }) =>
    specOf({
      name: 'apply_patch',
      description:
        'Create, update or delete one file. `diff` is a V4A diff: for create_file every line starts with "+"; for update_file use "@@" sections with " ", "-" and "+" lines. Use null where a field does not apply.',
      parameters: PatchParameters,
      execute: (input) => applyPatch(workspace, patchOperationOf(input), applyDiff),
    }),
  shell: ({ workspace, env, signal }) =>
    specOf({
      name: 'shell',
      description: `Run shell commands in ${workspace.cwd}, in order, stopping at the first failure.`,
      parameters: z.object({
        commands: z.array(z.string()),
        timeoutMs: z.number().int().positive().nullable(),
      }),
      execute: ({ commands, timeoutMs }) =>
        runShell(workspace, env, { commands, timeoutMs }, signal),
    }),
};

export function workspaceToolSpec(name: OpenAiAgentsToolName, context: ToolContext): ToolSpec {
  return WORKSPACE_TOOLS[name](context);
}

/** `run_skill_script`: a failed script throws, so the SDK reports it as a tool error. */
export function skillScriptToolSpec(
  skillScript: NonNullable<OpenAiAgentsCompiled['skillScript']>,
  signal: AbortSignal,
  toolAnswers?: ToolAnswers,
): ToolSpec {
  return {
    name: RUN_SKILL_SCRIPT_TOOL,
    description: skillScriptToolDescription(skillScript),
    parameters: OPENAI_AGENTS_SKILL_SCRIPT_INPUT,
    execute: async (input) => {
      const { text, isError } = await executeRunSkillScript(
        nodeSkillScriptHost,
        skillScript,
        input,
        signal,
        toolAnswers,
      );
      if (isError) throw new Error(text);
      return text;
    },
  };
}
