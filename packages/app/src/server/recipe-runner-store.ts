/**
 * The `store` of a recipe (ADR-0164): the app's resource stores with the person filled in, so a
 * recipe writes app data as the person's agent, in the run of the step it writes in.
 *
 * - The actor is the recipe run's person, or, for a schedule (no person), the member a step names
 *   with `actingFor`; with neither, every call is refused (`recipe_store_needs_person`).
 * - It acts `via: 'agent'`, so the store applies the person's `access` and the resource's
 *   `agents` (read, and the `agents.write` fields), exactly as the MCP endpoint decides an agent
 *   tool call. The role comes from the same member directory (the app key, 60 s cache).
 * - A write needs a step that started a run, whose id it carries as `run_id`; anywhere else it is
 *   refused (`recipe_write_needs_run`) before the store is called.
 */
import type { ResourceStore } from '../db/port.js';
import type { Person } from '../person.js';
import type { RecipeResourceStore, RecipeStoreOf } from '../recipe.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import type { MemberDirectory } from './mcp-person.js';
import { RecipeError } from './recipe-errors.js';

/** What a runner needs to give recipes a `store`: the app's stores and who is a member. */
export interface RecipeRecords {
  /** The store of one of the app's resources; the same one the routes and agent tools use. */
  readonly storeOf: <F extends FieldMap>(resource: DefinedResource<F>) => ResourceStore<F>;
  /** The member directory a person's role is read from. */
  readonly members: MemberDirectory;
  /** The workspace the app serves. */
  readonly workspaceId: string;
}

/** What `store` reads of the step it is called in. */
export interface ActingStep {
  /** The member a schedule's step acts for, or `null`. */
  readonly actingFor: string | null;
  /** The run the step started, or `null` before it started one. */
  readonly runId: string | null;
}

const PRINCIPAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Checks a step's `actingFor` before the step runs.
 *
 * @throws {RecipeError} `recipe_acting_for_refused` in a recipe run that has a person, for an id
 *   that is not a principal id, or for a principal who is not a member; `recipe_store_unavailable`
 *   when the runner has no member directory to ask.
 */
export async function assertActingFor(
  records: RecipeRecords | undefined,
  person: { readonly principalId: string } | null,
  actingFor: string,
): Promise<void> {
  if (person !== null) {
    throw new RecipeError(
      'recipe_acting_for_refused',
      'actingFor is only for a recipe with no person (a schedule)',
    );
  }
  if (!PRINCIPAL_ID.test(actingFor)) {
    throw new RecipeError('recipe_acting_for_refused', 'actingFor must be a principal id');
  }
  if (records === undefined) throw new RecipeError('recipe_store_unavailable');
  if ((await records.members.roleOf(actingFor)) === null) {
    throw new RecipeError('recipe_acting_for_refused', 'actingFor names no workspace member');
  }
}

/**
 * The `store` of one execution of a recipe run for `person`; `step` answers the step a call is
 * made in, or `undefined` outside every step.
 */
export function recipeStoreOfRun(
  records: RecipeRecords | undefined,
  person: { readonly principalId: string } | null,
  step: () => ActingStep | undefined,
): RecipeStoreOf {
  const actor = async (write: boolean): Promise<{ person: Person; records: RecipeRecords }> => {
    if (records === undefined) {
      throw new RecipeError(
        'recipe_store_unavailable',
        'the recipe runner was given no resource stores or member directory',
      );
    }
    const current = step();
    const principalId = person?.principalId ?? current?.actingFor ?? null;
    if (principalId === null) {
      throw new RecipeError(
        'recipe_store_needs_person',
        'a recipe with no person reads and writes only in a step with actingFor',
      );
    }
    const runId = current?.runId ?? null;
    if (write && runId === null) {
      throw new RecipeError(
        'recipe_write_needs_run',
        'a recipe writes only in a step that started a run, so the write carries its run_id',
      );
    }
    const role = await records.members.roleOf(principalId);
    return {
      records,
      person: Object.freeze({
        principalId,
        workspaceId: records.workspaceId,
        role,
        via: 'agent' as const,
        ...(runId === null ? {} : { runId }),
      }),
    };
  };
  return <F extends FieldMap>(resource: DefinedResource<F>): RecipeResourceStore<F> => {
    const call = async <T>(
      write: boolean,
      operation: (store: ResourceStore<F>, as: Person) => Promise<T>,
    ): Promise<T> => {
      const acting = await actor(write);
      return operation(acting.records.storeOf(resource), acting.person);
    };
    const bound: RecipeResourceStore<F> = {
      list: (options) => call(false, (store, as) => store.list(as, options)),
      get: (id) => call(false, (store, as) => store.get(as, id)),
      search: (query, options) => call(false, (store, as) => store.search(as, query, options)),
      create: (input) => call(true, (store, as) => store.create(as, input)),
      update: (id, patch) => call(true, (store, as) => store.update(as, id, patch)),
      delete: (id) => call(true, (store, as) => store.delete(as, id)),
    };
    return Object.freeze(bound);
  };
}
