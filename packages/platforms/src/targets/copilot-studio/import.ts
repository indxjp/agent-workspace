import {
  PlatformFileSchema,
  type FieldVerdict,
  type PlatformFile,
  type PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableKnowledgeUrlSchema,
  PortableProjectSchema,
  type PortableAgentInput,
} from '@indx-workspace/contracts/portable-agent';
import { parse } from 'yaml';
import { z } from 'zod';

import { dropped, mapped } from '../../paths.js';
import type { PlatformImportResult } from '../../port.js';
import { kebabOf } from './names.js';
import { CopilotStudioOptionsSchema } from './options.js';
import {
  ActionFileSchema,
  AgentFileSchema,
  CHILD_AGENT_KIND,
  ChildAgentFileSchema,
  MCP_METADATA_KIND,
  SettingsFileSchema,
  URL_KNOWLEDGE_KIND,
  URL_KNOWLEDGE_SOURCE_KIND,
  UrlKnowledgeFileSchema,
} from './vendor-shapes.js';

const OPTIONS_ID = 'copilot-studio';
const MAX_FILES = 10_000;
const YAML_SUFFIX = '.mcs.yml';
const KNOWLEDGE_FILES_DIR = 'knowledge/files/';
const NO_PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;
const OPTIONS_SHAPE = CopilotStudioOptionsSchema.shape;
const TOPICS_SCHEMA = OPTIONS_SHAPE.topics.unwrap();
const POWER_PLATFORM_NOTE =
  'a Power Platform component with no portable equivalent; recreate it by hand';

type Refusal = Extract<PlatformImportResult, { ok: false }>;

/** What the file walk gathers before the project is assembled. */
interface Collected {
  problems: string[];
  report: FieldVerdict[];
  options: Record<string, unknown>;
  topics: Record<string, string>;
  childAgents: PortableAgentInput[];
  urls: { kind: 'url'; url: string }[];
  knowledgeFiles: { path: string; content: string | Uint8Array }[];
  ignored: number;
}

function refuse(code: PlatformRefusal['code'], message: string, details: string[]): Refusal {
  return { ok: false, refusal: { code, message, details } };
}

/** Zod issue paths only: a message or a value could carry file content. */
function issuePaths(file: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${file}: ${issue.path.join('.') || '(document)'}`);
}

function textOf(file: PlatformFile): string | undefined {
  if (typeof file.content === 'string') return file.content;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    return undefined;
  }
}

/** Reads one `.mcs.yml` through a loose reader; `undefined` means the file is not valid. */
function read<T extends z.ZodType>(
  file: PlatformFile,
  schema: T,
  problems: string[],
): z.output<T> | undefined {
  const text = textOf(file);
  let document: unknown;
  try {
    document = text === undefined ? undefined : parse(text);
  } catch {
    document = undefined;
  }
  if (document === undefined || document === null) {
    problems.push(`${file.path}: is not valid YAML`);
    return undefined;
  }
  const result = schema.safeParse(document);
  if (!result.success) {
    problems.push(...issuePaths(file.path, result.error));
    return undefined;
  }
  return result.data;
}

function importSettings(file: PlatformFile, c: Collected): void {
  const settings = read(file, SettingsFileSchema, c.problems);
  const schemaName = settings?.schemaName;
  const underscore = schemaName?.indexOf('_') ?? -1;
  const publisherPrefix = schemaName?.slice(0, underscore);
  if (schemaName === undefined || underscore <= 0) {
    c.report.push(dropped(file.path, 'field_unsupported', 'no schemaName with a publisher prefix'));
  } else if (
    !OPTIONS_SHAPE.schemaName.safeParse(schemaName).success ||
    !OPTIONS_SHAPE.publisherPrefix.safeParse(publisherPrefix).success
  ) {
    c.report.push(
      dropped(
        file.path,
        'field_unsupported',
        `the schemaName does not fit the ${OPTIONS_ID} options; not imported`,
      ),
    );
  } else {
    c.options['schemaName'] = schemaName;
    c.options['publisherPrefix'] = publisherPrefix;
    c.report.push(mapped(file.path, `schemaName and publisherPrefix of the ${OPTIONS_ID} options`));
  }
}

function importChildAgent(file: PlatformFile, folder: string, c: Collected): void {
  const child = read(file, ChildAgentFileSchema, c.problems);
  if (child === undefined) return;
  if (child.kind !== CHILD_AGENT_KIND) {
    c.report.push(
      dropped(file.path, 'field_unsupported', `not an ${CHILD_AGENT_KIND}; not imported`),
    );
    return;
  }
  const name = kebabOf(folder);
  if (name === '') {
    c.problems.push(`${file.path}: folder name`);
    return;
  }
  const description = child.beginDialog?.description;
  c.childAgents.push({
    apiVersion: PORTABLE_AGENT_API_VERSION,
    kind: PORTABLE_AGENT_KIND,
    name,
    ...(description === undefined || description === '' ? {} : { description }),
    instructions: child.settings?.instructions ?? '',
    permissions: NO_PERMISSIONS,
  });
  c.report.push(mapped(file.path, `child agent ${name}: description and instructions`));
}

function importUrlKnowledge(file: PlatformFile, c: Collected): void {
  const source = read(file, UrlKnowledgeFileSchema, c.problems);
  if (source === undefined) return;
  const url = PortableKnowledgeUrlSchema.safeParse({ kind: 'url', url: source.source?.site });
  if (
    source.kind === URL_KNOWLEDGE_KIND &&
    source.source?.kind === URL_KNOWLEDGE_SOURCE_KIND &&
    url.success
  ) {
    c.urls.push({ kind: 'url', url: url.data.url });
    c.report.push(mapped(file.path, 'a URL knowledge source'));
  } else {
    c.report.push(
      dropped(
        file.path,
        'field_unsupported',
        `only an https ${URL_KNOWLEDGE_SOURCE_KIND} knowledge source is imported`,
      ),
    );
  }
}

function importTopic(file: PlatformFile, stem: string, c: Collected): void {
  const text = textOf(file);
  if (text !== undefined && TOPICS_SCHEMA.safeParse({ [stem]: text }).success) {
    c.topics[stem] = text;
    c.report.push(mapped(file.path, `kept verbatim in extensions.platforms.${OPTIONS_ID}.topics`));
  } else {
    c.report.push(
      dropped(
        file.path,
        'field_unsupported',
        'the topic name or text does not fit the options; not imported',
      ),
    );
  }
}

function importAction(file: PlatformFile, c: Collected): void {
  const action = read(file, ActionFileSchema, c.problems);
  if (action === undefined) return;
  c.report.push(
    dropped(
      file.path,
      'field_unsupported',
      action.action?.operationDetails?.kind === MCP_METADATA_KIND
        ? 'server URL lives in the custom connector, not the workspace; add tools[kind=mcp] by hand'
        : POWER_PLATFORM_NOTE,
    ),
  );
}

/** Routes one workspace file (path relative to the agent folder) to the reader for its kind. */
function importFile(file: PlatformFile, relative: string, c: Collected): void {
  const segments = relative.split('/');
  const [dir = '', second = ''] = segments;
  const isYaml = relative.endsWith(YAML_SUFFIX);

  if (relative === `settings${YAML_SUFFIX}`) {
    importSettings(file, c);
  } else if (dir === 'agents' && segments.length === 3 && segments[2] === `agent${YAML_SUFFIX}`) {
    importChildAgent(file, second, c);
  } else if (
    relative.startsWith(KNOWLEDGE_FILES_DIR) &&
    relative.length > KNOWLEDGE_FILES_DIR.length
  ) {
    c.knowledgeFiles.push({
      path: `knowledge/${relative.slice(KNOWLEDGE_FILES_DIR.length)}`,
      content: file.content,
    });
  } else if (
    dir === 'knowledge' &&
    segments.length === 2 &&
    relative.endsWith(`.knowledge${YAML_SUFFIX}`)
  ) {
    importUrlKnowledge(file, c);
  } else if (dir === 'topics' && segments.length === 2 && isYaml) {
    importTopic(file, relative.slice('topics/'.length, -YAML_SUFFIX.length), c);
  } else if (dir === 'actions' && isYaml) {
    importAction(file, c);
  } else if ((dir === 'workflows' || dir === 'triggers') && isYaml) {
    c.report.push(dropped(file.path, 'field_unsupported', POWER_PLATFORM_NOTE));
  } else {
    c.ignored += 1;
  }
}

/**
 * Best-effort import of a cloned `pac copilot` workspace (files at the root or under `agent/`)
 * into a project. Report paths are workspace file paths. A file that is not valid refuses the
 * import; a file with no portable equivalent is reported dropped.
 */
export function importCopilotStudio(files: readonly PlatformFile[]): PlatformImportResult {
  const parsed = z.array(PlatformFileSchema).max(MAX_FILES).safeParse(files);
  if (!parsed.success) {
    return refuse('platform_options_invalid', 'The workspace files are not valid.', [
      ...issuePaths('files', parsed.error),
    ]);
  }

  const prefix = parsed.data.some((file) => file.path === `agent/agent${YAML_SUFFIX}`)
    ? 'agent/'
    : '';
  const rootFile = parsed.data.find((file) => file.path === `${prefix}agent${YAML_SUFFIX}`);
  if (rootFile === undefined) {
    return refuse('platform_agent_not_found', 'The workspace has no agent.mcs.yml.', []);
  }

  const c: Collected = {
    problems: [],
    report: [],
    options: {},
    topics: {},
    childAgents: [],
    urls: [],
    knowledgeFiles: [],
    ignored: 0,
  };
  const root = read(rootFile, AgentFileSchema, c.problems);
  const rootName = root === undefined ? '' : kebabOf(root.displayName);
  if (root !== undefined && rootName === '') c.problems.push(`${rootFile.path}: displayName`);
  const modelNameHint = root?.aISettings?.model?.modelNameHint;
  if (OPTIONS_SHAPE.modelNameHint.safeParse(modelNameHint).success) {
    if (modelNameHint !== undefined) c.options['modelNameHint'] = modelNameHint;
  } else {
    c.report.push(
      dropped(
        rootFile.path,
        'field_unsupported',
        `the model name hint does not fit the ${OPTIONS_ID} options; not imported`,
      ),
    );
  }

  const sorted = [...parsed.data].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    if (file === rootFile) continue;
    if (file.path.startsWith(prefix)) importFile(file, file.path.slice(prefix.length), c);
    else c.ignored += 1;
  }

  if (c.problems.length > 0 || root === undefined) {
    return refuse(
      'platform_options_invalid',
      'The workspace cannot be imported.',
      c.problems.slice(0, 64),
    );
  }
  if (Object.keys(c.topics).length > 0) c.options['topics'] = c.topics;

  c.report.unshift(
    mapped(
      rootFile.path,
      'displayName, instructions, description, gptCapabilities and the model name hint',
    ),
  );
  if (c.ignored > 0) {
    c.report.push(
      dropped(
        'unrecognized-files',
        'field_unsupported',
        `${c.ignored} ${c.ignored === 1 ? 'file is' : 'files are'} not part of a portable agent; ignored`,
      ),
    );
  }

  const description = root['mcs.metadata']?.description;
  const project = PortableProjectSchema.safeParse({
    root: rootName,
    agents: [
      {
        apiVersion: PORTABLE_AGENT_API_VERSION,
        kind: PORTABLE_AGENT_KIND,
        name: rootName,
        ...(description === undefined || description === '' ? {} : { description }),
        instructions: root.instructions ?? '',
        permissions: NO_PERMISSIONS,
        tools: [
          ...(root.gptCapabilities?.webBrowsing ? [{ kind: 'builtin', id: 'web_search' }] : []),
          ...(root.gptCapabilities?.codeInterpreter
            ? [{ kind: 'builtin', id: 'code_execution' }]
            : []),
        ],
        knowledge: [
          ...(c.knowledgeFiles.length > 0
            ? [{ kind: 'files', paths: c.knowledgeFiles.map((file) => file.path) }]
            : []),
          ...c.urls,
        ],
        subagents: c.childAgents.map(({ name }) => ({ name })),
        ...(Object.keys(c.options).length > 0
          ? { extensions: { platforms: { [OPTIONS_ID]: c.options } } }
          : {}),
      },
      ...c.childAgents,
    ],
    knowledgeFiles: c.knowledgeFiles,
  });
  if (!project.success) {
    return refuse(
      'platform_options_invalid',
      'The workspace is not a valid project.',
      issuePaths('project', project.error),
    );
  }
  return { ok: true, project: project.data, report: c.report };
}
