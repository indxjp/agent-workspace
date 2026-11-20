/**
 * The pure readings of a stored agent version body (`unknown` here) that need no database; see
 * `./agent-versions.ts`. Kept apart from `./agent-versions-shared.ts` so that
 * `@agent-workspace/core/db-model` can carry them without loading drizzle or the schema.
 */
/** Whether a stored version body (`unknown` here) declares at least one subagent. */
export function bodyDeclaresSubagents(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const subagents: unknown = Reflect.get(body, 'subagents');
  return Array.isArray(subagents) && subagents.length > 0;
}

/** Whether a stored version body (`unknown` here) carries a non-empty `description`. */
export function bodyHasDescription(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const description: unknown = Reflect.get(body, 'description');
  return typeof description === 'string' && description.length > 0;
}

/**
 * The runtime profile applying a version to `local` leaves on the agent row (issue #832): the
 * profile the version names, as resolved; for a version naming none (`aw push` always sends
 * `null`), the profile the agent already has, and the resolved workspace default only when it has
 * none. A push therefore never detaches a profile the console or setup attached.
 */
export function appliedRuntimeProfileId(
  body: unknown,
  current: string | null,
  resolved: string | null,
): string | null {
  const definition: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'definition') : null;
  const agent: unknown =
    typeof definition === 'object' && definition !== null ? Reflect.get(definition, 'agent') : null;
  const named =
    typeof agent === 'object' && agent !== null
      ? typeof Reflect.get(agent, 'runtimeProfileName') === 'string'
      : false;
  return named ? resolved : (current ?? resolved);
}

/** The subagent names a stored version body (`unknown` here) declares, in body order. */
export function bodySubagentNames(body: unknown): readonly string[] {
  if (typeof body !== 'object' || body === null) return [];
  const subagents: unknown = Reflect.get(body, 'subagents');
  if (!Array.isArray(subagents)) return [];
  const names: string[] = [];
  for (const entry of subagents as readonly unknown[]) {
    const name: unknown =
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : undefined;
    if (typeof name === 'string') names.push(name);
  }
  return names;
}
