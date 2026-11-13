import {
  PROJECT_API_VERSION,
  PROJECT_KIND,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';
import {
  planProjectResources,
  type PlannedTool,
  type PlanSecret,
} from '@indx-workspace/sdk/project';
import path from 'node:path';
import type { LoadedTool } from '../project/load.js';
import { localProblem, problemsFromError, type ProjectProblem } from '../project/problems.js';
import { isProblem, plannedTool } from '../project/tools.js';
import { send, type Action } from './project-resources-actions.js';
import {
  FINGERPRINTS_FILE,
  readFingerprints,
  recordFingerprints,
  secretInputs,
  type Fingerprints,
} from './project-resources-fingerprints.js';
import type {
  AppliedProjectTools,
  AppliedTool,
  ApplyProjectToolsOptions,
} from './project-resources.js';

/** The plan path of a catalog tool: `tools.<name>`. */
const TOOL_PATH_PREFIX = 'tools.';

/** The project file a tool plan reads when there is none: only its `connectors` matter to a tool. */
const NO_PROJECT_FILE: ProjectDocument = {
  apiVersion: PROJECT_API_VERSION,
  kind: PROJECT_KIND,
  name: 'no-project-file',
  environments: { local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } } },
};

/**
 * C10, C15, SD16: the tool step `aw dev` runs on every sync and `aw push` runs once, before any
 * version is saved. Each catalog tool's document is read; `planProjectResources` decides which
 * tools to create or register again — a changed document, `allow`, auth or rotated secret — and
 * only its `tools.*` entries are kept, so the models and connectors applied at start are not
 * planned again. Notices go to stderr; a refusal is a `tool_refused` problem against the tool's
 * file, and a refused send that tool's server problem: either blocks the push. A secret's value is
 * read from the caller's own environment and only ever travels in a create or update body.
 */
export async function applyProjectTools(
  options: ApplyProjectToolsOptions,
  tools: readonly LoadedTool[],
): Promise<AppliedProjectTools> {
  const { client, io, root, signal } = options;
  const { problems, planned, fileOf } = await readProjectTools(options, tools);
  if (planned.length === 0) return { problems, tools: [] };

  let connectors;
  try {
    connectors = await client.connectors.list({ signal });
  } catch (error) {
    for (const file of new Set(fileOf.values())) {
      problems.push(...problemsFromError(error, file, []));
    }
    return { problems, tools: [] };
  }
  const fingerprintsFile = path.join(root, FINGERPRINTS_FILE);
  const recorded = await readFingerprints(fingerprintsFile);
  const names = planned.flatMap((tool) =>
    tool.definition.credential === undefined ? [] : [tool.definition.credential.secret],
  );
  const { values, secrets } = secretInputs([...new Set(names)], io.env, recorded);
  const plan = planProjectResources({
    project: options.project ?? NO_PROJECT_FILE,
    tools: planned,
    existing: { modelConnections: [], connectors },
    secrets,
  });
  const isTool = (entry: { readonly path: string }): boolean =>
    entry.path.startsWith(TOOL_PATH_PREFIX);
  const fileFor = (entry: { readonly path: string }): string => fileOf.get(entry.path) ?? '.';

  for (const notice of plan.notices.filter(isTool)) {
    if (options.printedNotices?.has(notice.message)) continue;
    options.printedNotices?.add(notice.message);
    io.stderr(`notice: ${notice.message}\n`);
  }
  const refused = new Set<string>();
  for (const refusal of plan.refusals.filter(isTool)) {
    refused.add(refusal.path);
    problems.push(localProblem(fileFor(refusal), 'tool_refused', [refusal.message]));
  }
  const { actions, failed } = await sendToolActions({
    options,
    toolActions: [...plan.creates, ...plan.updates].filter(isTool),
    values,
    secrets,
    fingerprintsFile,
    recorded,
    fileOf,
    problems,
  });
  const applied = planned.flatMap(({ definition }): AppliedTool[] => {
    const toolPath = `${TOOL_PATH_PREFIX}${definition.name}`;
    // A tool whose secret is unset was skipped; its notice says why.
    const unset = definition.credential !== undefined && !secrets.has(definition.credential.secret);
    if (refused.has(toolPath) || failed.has(toolPath) || unset) return [];
    const file = fileOf.get(toolPath) ?? '.';
    return [{ file, name: definition.name, action: actions.get(toolPath) ?? 'unchanged' }];
  });
  return { problems, tools: applied };
}

interface SendToolActionsOptions {
  readonly options: ApplyProjectToolsOptions;
  readonly toolActions: readonly Action[];
  readonly values: ReadonlyMap<string, string>;
  readonly secrets: ReadonlyMap<string, PlanSecret>;
  readonly fingerprintsFile: string;
  readonly recorded: Fingerprints;
  readonly fileOf: ReadonlyMap<string, string>;
  readonly problems: ProjectProblem[];
}

async function sendToolActions(input: SendToolActionsOptions) {
  const { options, toolActions, values, secrets, fingerprintsFile, recorded, fileOf, problems } =
    input;
  const { client, signal } = options;
  const yes = options.yes ?? true;
  const fileFor = (entry: { readonly path: string }): string => fileOf.get(entry.path) ?? '.';
  const sentSecrets = new Set<string>();
  const failedSecrets = new Set<string>();
  const actions = new Map<string, 'create' | 'update'>();
  const failed = new Set<string>();
  try {
    for (const action of toolActions) {
      actions.set(action.path, 'id' in action ? 'update' : 'create');
      if (!yes) continue;
      const secret = 'secret' in action ? action.secret : undefined;
      try {
        await send(client, action, values, signal);
      } catch (error) {
        if (secret !== undefined) failedSecrets.add(secret);
        if (signal.aborted) throw error;
        failed.add(action.path);
        problems.push(...problemsFromError(error, fileFor(action), []));
        continue;
      }
      if (secret !== undefined) sentSecrets.add(secret);
    }
  } finally {
    if (yes) {
      await recordFingerprints(
        { file: fingerprintsFile, recorded },
        secrets,
        { sentSecrets, failedSecrets },
        undefined,
      );
    }
  }
  return { actions, failed };
}

async function readProjectTools(options: ApplyProjectToolsOptions, tools: readonly LoadedTool[]) {
  const { root, io, signal } = options;
  const problems: ProjectProblem[] = [];
  const planned: PlannedTool[] = [];
  const fileOf = new Map<string, string>();
  for (const tool of tools) {
    const read = await plannedTool(tool, { root, io, signal });
    if (isProblem(read)) {
      problems.push(read);
      continue;
    }
    planned.push(read);
    fileOf.set(`${TOOL_PATH_PREFIX}${tool.definition.name}`, tool.file);
  }
  return { problems, planned, fileOf };
}
