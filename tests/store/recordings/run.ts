/**
 * Plays one visitor turn against a scripted workspace the way the Try tab does: start the run
 * with the entry's suggested prompt, follow it to its end, and while it waits for a person's
 * approval approve it and follow the continuation run. The frames are the SDK client's own, parsed
 * from the double's event stream; `recordTurn` turns them into the recorded turn.
 */
import type { AgentWorkspaceClient, StartRunInput } from '@indx-workspace/sdk';

import type { RecordedRun } from '../proof/record-turn.ts';

/** More continuations than any entry's moment needs; a model that never settles stops here. */
const MAX_RUNS = 4;

export interface Workspace {
  readonly aw: AgentWorkspaceClient;
  readonly agentId: string;
}

/** The runs `prompt` makes in `workspace`, in order, every approval wait approved. */
export async function playTurn(
  workspace: Workspace,
  prompt: string,
  /** What else the app sends with the question: the person it acts for, an uploaded file. */
  start: Omit<StartRunInput, 'prompt'> = {},
): Promise<readonly RecordedRun[]> {
  const { aw } = workspace;
  const played: RecordedRun[] = [];
  let { run } = await aw.runs.start(workspace.agentId, { ...start, prompt });
  while (played.length < MAX_RUNS) {
    const frames = [];
    for await (const frame of aw.runs.follow(run.id)) frames.push(frame);
    const settled = await aw.runs.get(run.id);
    if (settled.status !== 'awaiting_approval') return [...played, { frames }];
    played.push({ frames, decision: 'approved' });
    run = (await aw.runs.approve(run.id, {})).run;
  }
  throw new Error(`the turn "${prompt}" did not settle in ${String(MAX_RUNS)} runs`);
}
