import type { z } from 'zod';

/**
 * One reason a definition was refused: where, and why.
 *
 * `path` is dotted (`tools.1`, `engine.reasoningEffort`, `surfaces.0.agent`), and `(root)` when
 * the value itself is refused — the same spelling as the `details` of the server's
 * `invalid_agent_version` problem, so a message reads the same whether the SDK or the server found
 * it.
 */
export interface DefinitionIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * What every function of `@indx-workspace/sdk/define` throws when a definition is refused. It is
 * thrown at the call that received the bad value, so a project's `agents/*.ts` fails when it is
 * loaded rather than when it is pushed.
 *
 * It is a plain `Error`, not the HTTP client's `AgentWorkspaceError`: defining an agent makes no
 * request, and this subpath does not pull the client in.
 */
export class DefinitionError extends Error {
  override readonly name = 'DefinitionError';
  /** Always `invalid_definition`, so a caller can tell this error apart without `instanceof`. */
  readonly code = 'invalid_definition';
  /** Every reason the value was refused, at least one. */
  readonly issues: readonly DefinitionIssue[];

  constructor(subject: string, issues: readonly DefinitionIssue[]) {
    super(
      `${subject} is not a valid definition: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
    this.issues = Object.freeze([...issues]);
  }
}

/** The dotted spelling of an issue path, `(root)` for the value itself, under `prefix` if given. */
function dottedPath(path: readonly PropertyKey[], prefix?: string): string {
  const segments = [...(prefix === undefined ? [] : [prefix]), ...path.map(String)];
  return segments.length === 0 ? '(root)' : segments.join('.');
}

/** The edit distance between two short keys. */
function distance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (row[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      next.push(Math.min((next[j - 1] ?? 0) + 1, (row[j] ?? 0) + 1, substitution));
    }
    row = next;
  }
  return row[right.length] ?? 0;
}

/** ` (did you mean "instructions"?)` for the known key within two edits of `key`, else `''`. */
function suggestion(key: string, known: readonly string[]): string {
  const near = known
    .map((candidate) => ({
      candidate,
      score: distance(key.toLowerCase(), candidate.toLowerCase()),
    }))
    .filter(({ score }) => score <= 2)
    .toSorted((a, b) => a.score - b.score)[0];
  return near === undefined ? '' : ` (did you mean ${JSON.stringify(near.candidate)}?)`;
}

/**
 * Maps a Zod error's issues to {@link DefinitionIssue}s, each path under `prefix` if given. With
 * `known`, the root object's keys, an unknown root key also names the known key it is closest to
 * (BH061-046), so `instruction` says `did you mean "instructions"?`.
 */
export function issuesFromZod(
  error: z.ZodError,
  prefix?: string,
  known?: readonly string[],
): readonly DefinitionIssue[] {
  return error.issues.map((issue) => ({
    path: dottedPath(issue.path, prefix),
    message:
      issue.code === 'unrecognized_keys' && issue.path.length === 0 && known !== undefined
        ? issue.keys
            .map((key) => `Unrecognized key: ${JSON.stringify(key)}${suggestion(key, known)}`)
            .join('; ')
        : issue.message,
  }));
}
