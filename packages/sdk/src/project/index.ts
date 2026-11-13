/**
 * `@indx-workspace/sdk/project` — the project file and the starter project (issue #446,
 * contract C4).
 *
 * - **Reading.** {@link readProjectFileText} reads `agent-workspace.yaml` with a real YAML parser
 *   and refuses every construct that could make one file mean two things (ADR-0089);
 *   {@link parseProjectFile} then validates it against the contract's project schema, lifting a v1
 *   `Deployment` profile (ADR-0103). {@link readEvalCaseFile} reads an `evals/<agent>.yaml` case
 *   file (issue #618) the same way. Every refusal is a {@link ProjectFileError} naming its line
 *   and column.
 * - **Writing.** {@link writeProjectFileText} writes a mapping back in the canonical form the
 *   reader accepts, quoting only what would otherwise read back differently.
 * - **Asking.** {@link askSetupQuestions} is the one setup question loop (C20): it asks each
 *   question that applies through the caller's `prompt` and `say`, so `aw init` and `create` ask
 *   the same way.
 * - **Rendering.** {@link renderProjectFiles} turns the setup answers (ADR-0107) into
 *   `agent-workspace.yaml`, `agents/<agentName>.ts`, `surfaces/main.ts` and a `tools/<name>.ts`
 *   per internal tool, carrying the chosen theme's content (SD9);
 *   {@link setupSecretNames} names the variables the project reads its secrets from;
 *   {@link renderProjectShell} adds `package.json` (its dependencies are {@link projectDependencies}:
 *   the three packages and the chosen engine's), `pnpm-workspace.yaml` and `.gitignore`;
 *   {@link projectNameFor} derives the project's name from a directory name. `aw init` and
 *   `create` both render through these, so their output is the same. The starter files are a
 *   template directory, rendered by {@link renderTemplateDirectory}: real files whose `{{key}}`
 *   and `__key__` placeholders are replaced from a set of values.
 * - **Generating.** `aw generate app|resource|agent|page|recipe|channel` renders the `templates/<kind>/`
 *   directories through {@link renderGeneratorTemplate}, with values from {@link renderAppSpec},
 *   {@link renderResourceSpec} (its fields parsed by {@link parseFieldSpecs} from the
 *   `name:type` grammar; the same values render the resource's pages), {@link renderPageSpec},
 *   {@link renderAgentSpec}, {@link renderRecipeSpec} (its `--on` trigger) and
 *   {@link renderChannelSpec} (its key, from {@link refFieldsOf}; its route edits are
 *   {@link channelRouteEdits}). What it wrote is recorded in
 *   `aw-generated.json`, read by {@link parseGeneratedManifest} and written by
 *   {@link serializeGeneratedManifest}, so `aw destroy` removes exactly that, undoing each
 *   recorded edit with {@link revertGeneratedEdit}.
 *   `create --template <id>` renders {@link renderAppTemplate}: the `app` template, the
 *   template's pages over it and their manifest entry, with the {@link appKitPackages} pins
 *   added to `package.json` by {@link withAppPackages}; the project's own files are recorded as
 *   the entry `project:<name>`.
 * - **Blueprints.** An app blueprint (ADR-0166) is a versioned npm release of app parts.
 *   {@link parseBlueprintManifest} reads its `blueprint.json`; {@link planBlueprintInstall} plans
 *   `aw blueprint add`, and {@link planBlueprintUpdate} proposes each new version per file
 *   (`add`, `update`, `remove`, `conflict`), never overwriting an edited file; a destructive
 *   migration is refused by {@link destructiveMigrations}. {@link readBlueprintArchive} reads the
 *   package's gunzipped tarball, refusing links, unsafe paths and unlisted files. Its entry, `blueprint:<name>`, records
 *   the package's `source` in `aw-generated.json`.
 * - **Planning.** {@link planProjectResources} says what `aw dev` creates, updates, refuses and
 *   reports from the project file and its agents' tools (C10, C11, C15). It is pure, never
 *   deletes, and never holds a secret value: an action names its secret, and the caller sends it.
 * - **Isomorphic.** No Node.js module is imported; writing the files to disk is the caller's job.
 *
 * @packageDocumentation
 */
export {
  PROJECT_FILE_NAME,
  ProjectFileError,
  readProjectFileText,
  type ProjectFilePosition,
  type ProjectFileReading,
} from './reader.js';
export { writeProjectFileText, type ProjectFileMapping } from './writer.js';
export { parseProjectFile, readEvalCaseFile } from './parse.js';
export {
  chooseFromMenu,
  confirmMenu,
  MenuCancelledError,
  type Choose,
  type MenuOption,
  type MenuSpec,
} from './choose.js';
export {
  askSetupQuestions,
  isInteractive,
  mergeSetupAnswers,
  parseSetupAnswersFile,
  parseSetupFlags,
  setupFlagsHelp,
  unansweredSetupRefusal,
  type InteractionFacts,
} from './ask.js';
export { ENGINE_PACKAGES, projectDependencies } from './dependencies.js';
export {
  appendEvalCase,
  projectNameFor,
  renderProjectFiles,
  renderProjectShell,
  setupSecretNames,
} from './render.js';
export { renderTemplateDirectory, type ProjectFile } from './template.js';
export {
  appConfigLines,
  appConfigRecipeLines,
  channelRouteEdits,
  GENERATOR_FIELD_TYPES,
  GENERATOR_PAGE_KINDS,
  parseFieldSpec,
  parseFieldSpecs,
  renderAgentSpec,
  renderAppSpec,
  renderChannelSpec,
  renderFieldCode,
  renderGeneratorTemplate,
  renderPageSpec,
  renderRecipeSpec,
  renderResourceSpec,
  refFieldsOf,
  type ChannelRouteEdit,
  type ChannelSpecOptions,
  type FieldSpec,
  type GeneratorFieldType,
  type GeneratorPageKind,
  type GeneratorTemplate,
  type RecipeSpecOptions,
  type RecipeTriggerSpec,
  type RefFieldSpec,
  type TemplateValues,
} from './generate.js';
export {
  APP_PRESETS,
  type AppNavItem,
  type AppPreset,
  type AppPresetPart,
  type AppPresetResource,
} from './app-presets.js';
export {
  APP_TEMPLATES,
  appKitPackages,
  appScripts,
  renderAppTemplate,
  scriptEdit,
  withAppPackages,
  type AppScript,
  type AppTemplate,
  type PinnedPackage,
  type RenderedAppTemplate,
} from './templates.js';
export {
  addGeneratedEntry,
  EMPTY_GENERATED_MANIFEST,
  GENERATED_ENTRY_KINDS,
  GENERATED_MANIFEST_FILE,
  generatedEntryKey,
  parseGeneratedManifest,
  removeGeneratedEntry,
  serializeGeneratedManifest,
  type GeneratedEdit,
  type GeneratedEntry,
  type GeneratedEntryKind,
  type BlueprintSource,
  type GeneratedManifest,
} from './generated-manifest.js';
export {
  appKitSatisfies,
  BLUEPRINT_MANIFEST_FILE,
  BLUEPRINT_PART_KINDS,
  BlueprintManifestSchema,
  blueprintSidecarPath,
  destructiveMigrations,
  parseBlueprintManifest,
  planBlueprintInstall,
  planBlueprintUpdate,
  type BlueprintAppState,
  type BlueprintFile,
  type BlueprintFileAction,
  type BlueprintFileChange,
  type BlueprintInstallPlan,
  type BlueprintLocalState,
  type BlueprintManifest,
  type BlueprintMigrationWrite,
  type BlueprintPartKind,
  type BlueprintRelease,
  type BlueprintSlotStatus,
  type BlueprintUpdatePlan,
  type BlueprintWiring,
  type BlueprintWrite,
  type DestructiveMigration,
} from './blueprint.js';
export {
  BLUEPRINT_ARCHIVE_MAX_BYTES,
  BLUEPRINT_PACKAGE_KEYWORD,
  readBlueprintArchive,
  type BlueprintArchive,
} from './blueprint-archive.js';
export {
  MIGRATION_JOURNAL_FILE,
  PACKAGE_MANIFEST_FILE,
  readMigrationJournal,
  readPackageManifest,
  revertGeneratedEdit,
  serializeMigrationJournal,
  serializePackageManifest,
  type GeneratedEditRevert,
  type MigrationJournal,
  type MigrationJournalEntry,
  type PackageManifest,
} from './generated-edits.js';
export {
  planProjectResources,
  planProjectSkills,
  toolConnectorBody,
  type ExistingSkill,
  type PlanProjectResourcesInput,
  type PlanSecret,
  type PlannedTool,
  type ProjectResourceCreate,
  type ProjectResourceIssue,
  type ProjectResourcePlan,
  type ProjectResourceUpdate,
  type ProjectSkill,
  type ProjectSkillAction,
} from './plan.js';
export { ProjectRenderError, type ProjectRenderIssue } from './errors.js';
