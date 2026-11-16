/**
 * `defineApp`: a portal app, its resources and pages, and the agents it works with (issue #1501).
 */
import { NAME_KEY_PATTERN } from '@indx-workspace/contracts/project-file';
import { DefinitionError, issuesFromZod, type DefinitionIssue } from '@indx-workspace/sdk/define';
import { z } from 'zod';

import { brand, hasBrand, type AppBranded } from './brand.js';
import { IDENTIFIER_MAX } from './names.js';
import { isDefinedRecipe, recipeIssues, type DefinedRecipe } from './recipe.js';
import { isDefinedResource, type DefinedResource } from './resource.js';

/**
 * The longest an app name may be: its data lives in the PostgreSQL schema `app_<name>` (hyphens
 * as underscores), which must fit the 63-byte identifier limit.
 */
const APP_NAME_MAX = IDENTIFIER_MAX - 'app_'.length;

/** The most resources one app may define. */
const APP_MAX_RESOURCES = 100;

/** The most recipes one app may define. */
const APP_MAX_RECIPES = 100;

/** The app's pages: the one it opens on and the order of the navigation. */
export interface AppPages {
  readonly home?: string;
  readonly nav?: readonly string[];
}

/** What {@link defineApp} accepts. */
export interface AppInput<R extends readonly DefinedResource[] = readonly DefinedResource[]> {
  /** The app's name key: lower-case kebab, at most 59 characters (`service-desk`). */
  readonly name: string;
  /**
   * The app's resources. Empty is an app of pages only, as `aw generate app` and the portal
   * template write it before `aw generate resource` adds one.
   */
  readonly resources: R;
  /** The app's recipes (F-2), each made by `defineRecipe()`, with distinct names. */
  readonly recipes?: readonly DefinedRecipe[];
  readonly pages?: AppPages;
  /** The names of the project's agents (`agents/*.ts`) the app works with. */
  readonly agents?: readonly string[];
}

/** A defined app's settings, with every default filled in. */
export interface AppDefinition<R extends readonly DefinedResource[] = readonly DefinedResource[]> {
  readonly name: string;
  readonly resources: R;
  readonly recipes: readonly DefinedRecipe[];
  readonly pages: AppPages;
  readonly agents: readonly string[];
}

/** What {@link defineApp} returns: the app, frozen and branded. */
export type DefinedApp<R extends readonly DefinedResource[] = readonly DefinedResource[]> =
  AppDefinition<R> & AppBranded<'app'>;

const NameKeySchema = z
  .string()
  .regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters');

const AppInputSchema = z.strictObject({
  name: NameKeySchema.max(APP_NAME_MAX, {
    message: `must be at most ${String(APP_NAME_MAX)} characters, so the schema "app_<name>" fits`,
  }),
  resources: z
    .array(
      z.custom<DefinedResource>(isDefinedResource, {
        message: 'must be made by defineResource()',
      }),
    )
    .max(APP_MAX_RESOURCES),
  recipes: z
    .array(
      z.custom<DefinedRecipe>(isDefinedRecipe, {
        message: 'must be made by defineRecipe()',
      }),
    )
    .max(APP_MAX_RECIPES)
    .optional(),
  pages: z
    .strictObject({
      home: NameKeySchema.optional(),
      nav: z.array(NameKeySchema).max(32).optional(),
    })
    .optional(),
  agents: z.array(NameKeySchema).max(100).optional(),
});

const KNOWN_KEYS = Object.keys(AppInputSchema.shape);

/** The issues a list of distinct names has when one appears twice. */
function duplicateIssues(
  names: readonly string[],
  path: (index: number) => string,
  what: string,
): DefinitionIssue[] {
  return names.flatMap((name, index) =>
    names.indexOf(name) === index
      ? []
      : [{ path: path(index), message: `${what} ${JSON.stringify(name)} appears more than once` }],
  );
}

/** Duplicate names and plurals, and `ref()` fields naming a resource the app does not define. */
function resourceIssues(resources: readonly DefinedResource[]): DefinitionIssue[] {
  const names = resources.map((resource) => resource.name);
  const at = (index: number): string => `resources.${String(index)}`;
  const dangling = resources.flatMap((resource, index) =>
    Object.entries(resource.fields).flatMap(([key, field]): DefinitionIssue[] => {
      const target = field.options['resource'];
      if (field.type !== 'ref' || typeof target !== 'string' || names.includes(target)) return [];
      return [
        {
          path: `${at(index)}.fields.${key}`,
          message: `ref(${JSON.stringify(target)}) names no resource of this app`,
        },
      ];
    }),
  );
  return [
    ...duplicateIssues(names, at, 'the resource name'),
    ...duplicateIssues(
      resources.map((resource) => resource.plural),
      (index) => `${at(index)}.plural`,
      'the plural',
    ),
    ...dangling,
  ];
}

/**
 * Defines a portal app: its name, its resources, its pages and the agents it works with. Every
 * mistake is reported at once: the shape, a resource not made by `defineResource()`, two resources
 * with one name or plural, a `ref()` naming a resource the app does not define, a recipe not made
 * by `defineRecipe()`, two recipes with one name, and a `resourceEvent` naming a resource the app
 * does not define.
 *
 * @throws {DefinitionError} with every reason the input was refused.
 */
export function defineApp<const R extends readonly DefinedResource[]>(
  input: AppInput<R>,
): DefinedApp<R> {
  const result = AppInputSchema.safeParse(input);
  if (!result.success) {
    throw new DefinitionError('defineApp()', issuesFromZod(result.error, undefined, KNOWN_KEYS));
  }
  const issues = [
    ...resourceIssues(result.data.resources),
    ...recipeIssues(
      result.data.recipes ?? [],
      result.data.resources.map((resource) => resource.name),
    ),
  ];
  if (issues.length > 0) throw new DefinitionError('defineApp()', issues);
  const { pages } = result.data;
  const definition: AppDefinition<R> = {
    name: result.data.name,
    resources: Object.freeze([...input.resources]) as unknown as R,
    recipes: Object.freeze([...(input.recipes ?? [])]),
    pages: Object.freeze({
      ...(pages?.home === undefined ? {} : { home: pages.home }),
      ...(pages?.nav === undefined ? {} : { nav: Object.freeze([...pages.nav]) }),
    }),
    agents: Object.freeze([...(result.data.agents ?? [])]),
  };
  return brand(definition, 'app');
}

/** Whether `value` was made by {@link defineApp}, in this copy of the app kit or another. */
export function isDefinedApp(value: unknown): value is DefinedApp {
  return hasBrand(value, 'app');
}
