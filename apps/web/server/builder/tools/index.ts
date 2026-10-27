import type { BuilderToolName } from '@indx-workspace/contracts/builder';

import type { Facts } from '../core/facts';
import type { CallContext } from '../ports';
import { catalogList } from './catalog-list';
import { draftCheck } from './draft-check';
import { draftSave } from './draft-save';
import { evalsRun } from './evals-run';
import { examplesGet } from './examples-get';
import { trialRun } from './trial-run';
import type { BuilderPorts, CallOf, Executors } from './types';

/** One executor per aw-control tool; the mapped type makes the record exhaustive. */
export const TOOLS: Executors = {
  catalog_list: catalogList,
  examples_get: examplesGet,
  draft_check: draftCheck,
  draft_save: draftSave,
  evals_run: evalsRun,
  trial_run: trialRun,
};

/** Runs the executor for the call's own tool. */
export function execute<K extends BuilderToolName>(
  call: CallOf<K>,
  ctx: CallContext,
  ports: BuilderPorts,
  creator: Facts['creator'],
) {
  const executor: Executors[K] = TOOLS[call.tool];
  return executor(call, ctx, ports, creator);
}
