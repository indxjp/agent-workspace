import type { BuilderToolInputs, BuilderToolName } from '@indx-workspace/contracts/builder';

/** One parsed tool call: the tool and its validated input, as the shell hands it to the core. */
export type ToolCall = {
  readonly [K in BuilderToolName]: {
    readonly tool: K;
    readonly input: BuilderToolInputs[K];
    readonly callId: string;
  };
}[BuilderToolName];

/** The tools that carry a whole agent body for the pipeline to check or save. */
type DraftToolName = 'draft_check' | 'draft_save';
type DraftCall = Extract<ToolCall, { readonly tool: DraftToolName }>;

export function isDraftTool(tool: BuilderToolName): tool is DraftToolName {
  switch (tool) {
    case 'draft_check':
    case 'draft_save':
      return true;
    case 'catalog_list':
    case 'examples_get':
    case 'evals_run':
    case 'trial_run':
      return false;
    default: {
      const unhandled: never = tool;
      return unhandled;
    }
  }
}

export function isDraftCall(call: ToolCall): call is DraftCall {
  return isDraftTool(call.tool);
}
