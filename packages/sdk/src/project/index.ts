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
 *   `create` both render through these, so their output is the same.
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
  type ProjectFile,
} from './render.js';
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
