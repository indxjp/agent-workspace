/**
 * `@indx-workspace/app`: the definitions a portal app is written in, which run anywhere (a page,
 * a route handler, `aw` through the `aw-app` bin, a test). Nothing here imports Drizzle, Next.js
 * or React.
 *
 * - {@link defineResource} and {@link defineApp} validate a definition and throw the SDK's
 *   `DefinitionError` listing every reason; what they return is branded and frozen.
 * - The field builders (`text`, `richText`, `number`, `money`, `bool`, `date`, `dateTime`,
 *   `enumOf`, `person`, `ref`, `files`, `tags`) each carry their column, value schema, form
 *   control, list cell and agent-tool schema as plain data.
 * - {@link createInputSchema}, {@link updateInputSchema} and {@link recordSchema} are the one
 *   place the record schemas are built from the fields.
 * - {@link definePages} defines the page kind (issue #1520): a resource of nested pages with a
 *   rich-text body of blocks ({@link PAGE_BLOCK_TYPES}), revisions and lexical search;
 *   {@link blocksToMarkdown} and {@link markdownToBlocks} are the one conversion of its body.
 * - {@link defineRecipe} defines a recipe (F-2): TypeScript the app runs over the SDK, one
 *   idempotent platform run per `step`, started by a {@link resourceEvent} or a {@link schedule}.
 * - {@link Person} is who an operation runs for, and {@link allows} the one access check every
 *   store operation, route and agent tool applies.
 *
 * This package's `files()` is a record attachment field. It is not `@indx-workspace/sdk/define`'s
 * `files()`, which grants an agent access to files; a resource file and an agent file never import
 * both.
 *
 * @packageDocumentation
 */
export {
  defineApp,
  isDefinedApp,
  type AppDefinition,
  type AppInput,
  type AppPages,
  type DefinedApp,
} from './app.js';
export {
  bool,
  date,
  dateTime,
  enumOf,
  files,
  money,
  number,
  person,
  ref,
  richText,
  tags,
  text,
  type AnyField,
  type BoolOptions,
  type CellKind,
  type ColumnSpec,
  type ColumnSql,
  type ControlKind,
  type DateOptions,
  type EnumOptions,
  type FieldDefinition,
  type FieldType,
  type FilesOptions,
  type JsonSchema,
  type Money,
  type MoneyOptions,
  type NumberOptions,
  type PersonOptions,
  type RefOptions,
  type RichTextBlock,
  type RichTextOptions,
  type TagsOptions,
  type TextOptions,
} from './fields/index.js';
export {
  blocksPlainText,
  blocksToMarkdown,
  definePages,
  isPageResource,
  markdownToBlocks,
  PAGE_BLOCK_TYPES,
  PAGE_TITLE_MAX,
  pageBlockIssues,
  type DefinedPages,
  type PageBaseFields,
  type PageBlockType,
  type PageFieldName,
  type PagesInput,
  type PageSpaceFields,
} from './pages/index.js';
export { allows, type Person } from './person.js';
export {
  defineRecipe,
  isDefinedRecipe,
  RECIPE_NAME_PATTERN,
  RESOURCE_EVENTS,
  resourceEvent,
  schedule,
  STEP_KEY_PATTERN,
  type DefinedRecipe,
  type Json,
  type RecipeClient,
  type RecipeContext,
  type RecipeDefinition,
  type RecipeInput,
  type RecipeOn,
  type RecipeResourceStore,
  type RecipeRunsClient,
  type RecipeRunStart,
  type RecipeStartInput,
  type RecipeStoreOf,
  type ResourceEventInput,
  type ResourceEventName,
  type ResourceEventOn,
  type ScheduleInput,
  type ScheduleOn,
  type StepFn,
  type StepOptions,
} from './recipe.js';
export {
  defineResource,
  isDefinedResource,
  RESERVED_FIELD_NAMES,
  type AccessOperation,
  type AccessRule,
  type AccessRules,
  type DefinedResource,
  type FieldMap,
  type ResourceDefinition,
  type ResourceInput,
} from './resource.js';
export {
  createInputSchema,
  recordSchema,
  updateInputSchema,
  type CreateInput,
  type RecordOf,
  type ReservedColumns,
  type UpdateInput,
  type ValueOf,
} from './schemas.js';
