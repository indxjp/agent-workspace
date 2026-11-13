import { themeSkillFiles } from './setup-examples.js';
import { frozenFiles } from './template.js';

import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { HOSTED_PLATFORM_IDS } from '@indx-workspace/contracts/platforms';
import {
  DEFAULT_BOOTSTRAP_ADMIN,
  PROJECT_API_VERSION,
  PROJECT_KIND,
} from '@indx-workspace/contracts/project-file';
import {
  CompleteSetupAnswersSchema,
  THEME_RECOMMENDATIONS,
  type CompleteSetupAnswers,
} from '@indx-workspace/contracts/setup';

import { defineAgent, defineSurface, skill } from '../define/index.js';
import { Code, definitionFile, tsString } from './definition-source.js';
import { ProjectRenderError } from './errors.js';
import { defined, parsed, ProjectSchema } from './render-validation.js';
import { evalFiles, THEME_SKILLS } from './setup-examples.js';
import { projectFileHeader, setupModelConfiguration } from './setup-models.js';
import { agentsFile, starterFor, withPlatformsReadme } from './setup-starters.js';
import { setupSecretNames, setupTools } from './setup-tools.js';
import { type ProjectFile } from './template.js';
import { writeProjectFileText, type ProjectFileMapping } from './writer.js';

function setupDefinitions(valid: CompleteSetupAnswers) {
  const agentName = valid['content.agentName'];
  const { instructions, greeting, prompts } = THEME_RECOMMENDATIONS[valid['setup.theme']].content;
  const permissions = AGENT_PERMISSION_KEYS.filter((key) =>
    valid['content.permissions'].includes(key),
  );
  const tools = setupTools(valid);
  const themed: Partial<
    Record<(typeof valid)['setup.theme'], (typeof THEME_SKILLS)[keyof typeof THEME_SKILLS]>
  > = THEME_SKILLS;
  const exampleSkill = themed[valid['setup.theme']];
  const agentInput = {
    name: agentName,
    instructions,
    engine: valid['content.engine'],
    model: 'default',
    ...(permissions.length === 0
      ? {}
      : { permissions: Object.fromEntries(permissions.map((key) => [key, true])) }),
  };
  const parts = {
    ...(greeting === undefined ? {} : { greeting }),
    ...(prompts.length === 0 ? {} : { suggestedPrompts: prompts }),
    // The support starter's surface asks for feedback on each answer (issue #696).
    ...(valid['setup.theme'] === 'support' ? { feedback: true } : {}),
  };
  const surfaceInput = {
    name: 'main',
    agent: agentName,
    title: valid['embedder.surfaceTitle'],
    theme: { colour: valid['embedder.brandColour'] },
    ...(Object.keys(parts).length === 0 ? {} : { parts }),
  };
  defined(`agents/${agentName}.ts`, () =>
    defineAgent({
      ...agentInput,
      ...(tools.length === 0 ? {} : { tools: tools.map((tool) => tool.tool) }),
      ...(exampleSkill === undefined ? {} : { skills: [skill(exampleSkill.name)] }),
    }),
  );
  defined('surfaces/main.ts', () => defineSurface(surfaceInput));

  return { agentName, agentInput, surfaceInput, permissions, tools, exampleSkill };
}

function renderAgentSource(
  definitions: ReturnType<typeof setupDefinitions>,
  agentTools: readonly Pick<ReturnType<typeof setupTools>[number], 'name' | 'identifier'>[],
): string {
  const { agentInput, exampleSkill, permissions } = definitions;
  return definitionFile(
    'defineAgent',
    {
      ...agentInput,
      ...(agentTools.length === 0
        ? {}
        : { tools: agentTools.map((tool) => new Code(tool.identifier)) }),
      ...(exampleSkill === undefined
        ? {}
        : { skills: [new Code(`skill(${tsString(exampleSkill.name)})`)] }),
    },
    // SD12: the extensionless specifier ADR-0111's linker resolves.
    {
      ...(exampleSkill === undefined ? {} : { sdk: ['skill'] }),
      local: agentTools.map((tool) => `import ${tool.identifier} from '../tools/${tool.name}';`),
    },
    // #1132: an uploaded file reaches a run only through a grant. The example stays a comment
    // because a grant to a folder the workspace does not have leaves `aw dev`'s push unresolved.
    [
      'To let the agent read files you upload on the Files screen, add `files` to the import',
      'above and grant a folder:',
      // An agent the answers already grant `readFiles` has a `permissions` key to extend.
      ...(permissions.includes('readFiles') ? [] : ['  permissions: { readFiles: true },']),
      "  files: [files('uploads')],",
      'The folder must exist in the workspace first, or `aw dev` reports it as missing.',
    ],
  );
}

function setupProjectSelection(valid: CompleteSetupAnswers) {
  const sandbox = valid['admin.sandbox'];
  const platforms = HOSTED_PLATFORM_IDS.filter((id) => valid['admin.platforms'].includes(id));
  const featureAnswer = valid['admin.features'];
  const features =
    featureAnswer === undefined
      ? FEATURE_IDS
      : FEATURE_IDS.filter((id) => featureAnswer.includes(id));
  return { sandbox, platforms, features };
}

function renderProjectManifest(
  valid: CompleteSetupAnswers,
  name: string,
  selection: ReturnType<typeof setupProjectSelection>,
): string {
  const { sandbox, platforms, features } = selection;
  const { models, keyVariable, hasPlaceholders } = setupModelConfiguration(valid);
  const local: ProjectFileMapping = {
    cloud: 'local',
    // `sandbox-runtime` is a deprecated answer with no implementation: it renders as `local`.
    ...(sandbox === 'auto' ? {} : { runtime: { default: 'local' } }),
    identity: { bootstrapAdmin: DEFAULT_BOOTSTRAP_ADMIN },
  };
  return writeProjectFileText(
    {
      apiVersion: PROJECT_API_VERSION,
      kind: PROJECT_KIND,
      name,
      ...models,
      environments: { local },
      ...(platforms.length === 0
        ? {}
        : { platforms: Object.fromEntries(platforms.map((id) => [id, { enabled: true }])) }),
      ...(features.length === FEATURE_IDS.length ? {} : { features }),
    },
    projectFileHeader(keyVariable, hasPlaceholders),
  );
}

/**
 * Renders the files a project's setup answers are written into, in `SETUP_FILE_PATHS` order:
 * `agent-workspace.yaml`, `agents/<agentName>.ts`, `surfaces/main.ts`, then one `tools/<name>.ts`
 * per internal tool, sorted by name (issue #543, SD9, SD12), then the theme's starter files
 * (`starters/<theme>/`: `automation` adds tools, a fake API, a README and its eval file; `support`
 * and `copilot` a README and eval file, `copilot` also a Vite page in `web/`; an internal tool that
 * would write one of a starter's paths is refused). `aw init` refuses a directory where any of
 * them exists, as it does for every rendered path, except an existing `README.md` or `AGENTS.md`,
 * which it keeps. `AGENTS.md` tells a coding agent how to run the project without a terminal.
 *
 * - `agent-workspace.yaml` is a v2 `Project` with one `local` environment; it names a runtime only
 *   when the sandbox answer is not `auto`, and no port or storage (`aw dev` provides both). A model
 *   provider other than `anthropic` adds `models.default`: its credential is a secret reference,
 *   and each required setting no question asks for is a `your-` placeholder the header names.
 * - The agent carries the theme's instructions and any permissions the answers switch on, and
 *   imports and lists each tool; the surface carries the theme's greeting and suggested prompts.
 *   Theme `blank` renders the slice-1 files byte for byte.
 * - A platform answer other than `none` adds a `platforms:` block to `agent-workspace.yaml` (in
 *   `PLATFORM_IDS` order) and the `aw platforms` commands to `README.md` and `AGENTS.md`; `none`
 *   changes no file.
 * - A features answer that is not every feature adds a `features:` list (in `FEATURE_IDS` order);
 *   an absent answer or every feature writes no key, which means all installed (ADR-0160 D5).
 * - An OpenAPI tool is named after its document's file name up to the first `.`, reads its token
 *   from `<NAME>_TOKEN` and allows only `GET`; the PostgreSQL tool reads its URL from
 *   `POSTGRES_URL` and names one placeholder table.
 * - Every definition is passed through its `define*` call before it is printed, so a file this
 *   writes always loads.
 *
 * The result is frozen. `project.name` is the project's name key; `projectNameFor` derives one from
 * a directory name.
 *
 * @throws {ProjectRenderError} when an answer, or the name, is refused.
 */
export function renderProjectFiles(
  answers: CompleteSetupAnswers,
  project: { readonly name: string; readonly version?: string },
): readonly ProjectFile[] {
  const valid = parsed(CompleteSetupAnswersSchema, answers, 'the setup answers');
  const { name, version } = parsed(ProjectSchema, project, 'the project');

  const definitions = setupDefinitions(valid);
  const { agentName, surfaceInput, tools, exampleSkill } = definitions;
  const selection = setupProjectSelection(valid);
  const { platforms } = selection;
  const starter = starterFor(valid['setup.theme'], agentName, version);
  const taken = new Set(starter.files.map((file) => file.path));
  const clash = tools.find((each) => taken.has(each.path));
  if (clash !== undefined) {
    throw new ProjectRenderError('the setup answers', [
      {
        path: 'content.openapiDocument',
        message: `would write ${clash.path}, which the ${valid['setup.theme']} starter already has; rename the document`,
      },
    ]);
  }
  const agentTools = [...tools, ...starter.tools];
  const projectFile = renderProjectManifest(valid, name, selection);
  const agentFile = renderAgentSource(definitions, agentTools);

  return frozenFiles([
    { path: 'agent-workspace.yaml', contents: projectFile },
    { path: `agents/${agentName}.ts`, contents: agentFile },
    { path: 'surfaces/main.ts', contents: definitionFile('defineSurface', surfaceInput) },
    ...tools.map(({ path, contents }) => ({ path, contents })),
    ...(platforms.length === 0
      ? starter.files
      : withPlatformsReadme(starter.files, agentName, platforms)),
    { path: 'AGENTS.md', contents: agentsFile(setupSecretNames(valid), platforms) },
    ...evalFiles(valid['setup.theme'], agentName),
    ...themeSkillFiles(exampleSkill),
  ]);
}

export { renderProjectShell } from './render-shell.js';
export { projectNameFor } from './render-validation.js';

export { appendEvalCase } from './setup-examples.js';
export { setupSecretNames } from './setup-tools.js';
