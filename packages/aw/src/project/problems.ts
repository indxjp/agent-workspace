import { ApiProblemError, ContractsVersionUnsupportedError } from '@indx-workspace/sdk';

/**
 * One reason a project file cannot be saved as it is (issue #452): the file it is attributed to,
 * the HTTP status the server answered — `null` for a refusal the loader made on this machine —
 * the problem code, and its details.
 */
export interface ProjectProblem {
  /** The file, relative to the project root, with `/` separators: `agents/assistant.ts`. */
  readonly file: string;
  readonly status: number | null;
  readonly code: string;
  readonly details: readonly string[];
  /**
   * What to do about it, printed after the details as `; <hint>`. Only a refusal `aw dev` makes,
   * or a line plain-text `aw push` prints, carries one, so `aw check --json` and `aw push --json`
   * never do.
   */
  readonly hint?: string;
  /** Where the type stripper or the evaluator reports the problem; `file` is project-relative. */
  readonly location?:
    { readonly file: string; readonly line: number; readonly column: number } | undefined;
}

/** A refusal the loader made locally, before any request. */
export function localProblem(
  file: string,
  code: string,
  details: readonly string[] = [],
): ProjectProblem {
  return { file, status: null, code, details };
}

/**
 * `<file>: <status|local> <code>[ [d1, d2]][; hint]` — the line `aw check`, `aw push` and `aw dev`
 * print, the same for a local refusal and a server answer:
 * `agents/assistant.ts: 422 engine_capability_unsupported [mcp]`.
 */
export function formatProblem(problem: ProjectProblem): string {
  // `✗ path:line:col  message`, the shape editors and terminals make clickable.
  if (problem.location !== undefined) {
    const { file, line, column } = problem.location;
    const loading = file === problem.file ? '' : ` (loading ${problem.file})`;
    return `✗ ${file}:${String(line)}:${String(column)}  ${problem.details.join(', ')}${loading}`;
  }
  const status = problem.status === null ? 'local' : String(problem.status);
  const details = problem.details.length === 0 ? '' : ` [${problem.details.join(', ')}]`;
  const hint = problem.hint === undefined ? '' : `; ${problem.hint}`;
  return `${problem.file}: ${status} ${problem.code}${details}${hint}`;
}

/** The code of an agent `aw dev` will not sync over because it was edited in the UI. */
export const EDITED_IN_UI_CODE = 'edited_in_ui';

/**
 * An agent edited outside `aw`: one made outside it, with no `local` pointer, or one whose row
 * (`agentUpdatedAt`) changed after its `local` pointer last moved.
 */
export type EditedInUi =
  | { readonly name: string; readonly pointer: null }
  | {
      readonly name: string;
      /** The agent row's `updatedAt`: when the edit outside versions was last made. */
      readonly agentUpdatedAt: string;
      readonly pointer: { readonly number: number; readonly updatedAt: string };
    };

/**
 * SD11/C21 (ADR-0101): `aw dev` refuses to sync over an agent edited in the UI and says how to
 * overwrite it on purpose:
 * `agents/assistant.ts: local edited_in_ui ["assistant" edited <t>, local 1 set <t>]; run …`.
 */
export function editedInUiProblem(file: string, edited: EditedInUi): ProjectProblem {
  const details =
    edited.pointer === null
      ? [`"${edited.name}" has no local pointer`]
      : [
          `"${edited.name}" edited ${edited.agentUpdatedAt}`,
          `local ${String(edited.pointer.number)} set ${edited.pointer.updatedAt}`,
        ];
  return {
    file,
    status: null,
    code: EDITED_IN_UI_CODE,
    details,
    hint: 'run `aw push --yes` to overwrite it with this file',
  };
}

/**
 * The folders an `agent_definition_references_missing` refusal names when every detail is a
 * `file:<folder>`, else `undefined`. A folder exists once a file is uploaded into it, and no edit
 * to the project file creates one.
 */
export function missingFolders(problem: ProjectProblem): readonly string[] | undefined {
  if (problem.code !== 'agent_definition_references_missing' || problem.details.length === 0) {
    return undefined;
  }
  const folders = problem.details.flatMap((detail) =>
    detail.startsWith('file:') ? [detail.slice('file:'.length)] : [],
  );
  return folders.length === problem.details.length ? folders : undefined;
}

/**
 * The problem with the next step `aw dev` and `aw push` print for a {@link missingFolders}
 * refusal.
 */
export function withMissingFolderHint(problem: ProjectProblem): ProjectProblem {
  const folders = missingFolders(problem);
  if (folders === undefined) return problem;
  return {
    ...problem,
    hint: `upload a file into ${folders.join(', ')} (aw files upload <folder>/<name> <local-file>), then save again or run aw push --yes`,
  };
}

/** `aw check`'s and `aw push`'s refusal message: `1 problem`, `3 problems`. */
export function problemCount(count: number): string {
  return `${String(count)} problem${count === 1 ? '' : 's'}`;
}

/** The index of the surface a `surfaces.<i>.…` detail of `invalid_agent_version` names. */
function surfaceIndexOf(detail: string): number | undefined {
  const match = /^surfaces\.(\d+)(?:[.:])/u.exec(detail);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * BH061-019: `model: 'claude-haiku-4-5'` names a model connection, not a model, so the server
 * refuses it as `agent_definition_references_missing [model-connection:claude-haiku-4-5]`. Say how
 * to name a model instead.
 */
function missingConnectionHint(error: ApiProblemError): string | undefined {
  if (error.code !== 'agent_definition_references_missing') return undefined;
  const name = error.details
    .find((detail) => detail.startsWith(MODEL_CONNECTION_DETAIL))
    ?.slice(MODEL_CONNECTION_DETAIL.length);
  return name === undefined
    ? undefined
    : `model: '${name}' names a model connection the workspace lacks; to choose a model, write model: { connection: 'default', id: '${name}' }`;
}

const MODEL_CONNECTION_DETAIL = 'model-connection:';

/**
 * The problems one server refusal of an agent's version makes, attributed to the files they come
 * from. An `invalid_agent_version` detail that names `surfaces.<i>` belongs to the file of that
 * surface; everything else belongs to the agent's file.
 *
 * Only an {@link ApiProblemError} is a problem of the project. A transport or contract failure,
 * and the contracts-version skew (which no file can fix), are rethrown, so they keep their own
 * exit codes.
 */
export function problemsFromError(
  error: unknown,
  agentFile: string,
  surfaceFiles: readonly string[],
): readonly ProjectProblem[] {
  if (!(error instanceof ApiProblemError) || error instanceof ContractsVersionUnsupportedError) {
    throw error;
  }
  if (error.code !== 'invalid_agent_version') {
    const problem = {
      file: agentFile,
      status: error.status,
      code: error.code,
      details: error.details,
    };
    const hint = missingConnectionHint(error);
    return [hint === undefined ? problem : { ...problem, hint }];
  }
  const byFile = new Map<string, string[]>();
  for (const detail of error.details) {
    const index = surfaceIndexOf(detail);
    const file = (index === undefined ? undefined : surfaceFiles[index]) ?? agentFile;
    const entries = byFile.get(file);
    if (entries === undefined) byFile.set(file, [detail]);
    else entries.push(detail);
  }
  if (byFile.size === 0) {
    return [{ file: agentFile, status: error.status, code: error.code, details: [] }];
  }
  return [...byFile].map(([file, details]) => ({
    file,
    status: error.status,
    code: error.code,
    details,
  }));
}
