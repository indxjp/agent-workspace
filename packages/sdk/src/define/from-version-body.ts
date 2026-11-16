import {
  AgentVersionBodySchema,
  type AgentVersionBody,
  type AgentVersionToolBundle,
} from '@indx-workspace/contracts/agent-versions';
import { claudeDeniedToolsFor, engineSettingsOf } from '@indx-workspace/contracts/agents';
import { DEFAULT_ENGINE_ID } from '@indx-workspace/contracts/engines';
import type { ProjectConnector, ProjectDocument } from '@indx-workspace/contracts/project-file';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import {
  DefineAgentInputSchema,
  defineAgent,
  toolNameOf,
  type DefineTool,
  type DefinedAgent,
} from './agent.js';
import { DefinitionError, issuesFromZod } from './errors.js';
import {
  files,
  isCodeTool,
  isOpenApiTool,
  isPostgresTool,
  mcp,
  skill,
  type CodeTool,
  type OpenApiTool,
  type PostgresTool,
} from './references.js';
import type { DefinedSurface } from './surface.js';
import { toAgentVersionBody } from './version-body.js';

const SUBJECT = 'agentFromVersionBody()';

/** One tool a project module exports: what aw's loader evaluates under `tools/` (or any module). */
export interface ToolModuleExport {
  /** The module's project-relative POSIX path, as aw reports a tool's file: `tools/crm.ts`. */
  readonly module: string;
  /** `default`, or the named export: `crm`. */
  readonly exportName: string;
  readonly tool: OpenApiTool | PostgresTool | CodeTool;
}

/** What {@link agentFromVersionBody} reads: the body, and the project it belongs to. */
export interface AgentVersionSource {
  readonly body: AgentVersionBody;
  /** The parsed `agent-workspace.yaml`, or what stands for it. */
  readonly project?: Pick<ProjectDocument, 'engine' | 'connectors'> | undefined;
  /** Every tool the project's modules export; see {@link toolModulesOf}. */
  readonly toolModules?: readonly ToolModuleExport[] | undefined;
  /** The project's surfaces that name this agent: `body.surfaces` must be exactly theirs. */
  readonly surfaces?: readonly DefinedSurface[] | undefined;
  /**
   * The agent's code tools, in order, which the body only names as `aw-dev-tools`; each must be
   * a `defineTool()` export in `toolModules`. Absent, the names come from `body.toolBundles`.
   */
  readonly codeToolNames?: readonly string[] | undefined;
}

/** A part of the body that {@link agentFromVersionBody} could not write back, and why. */
export interface VersionBodyDrop {
  /** Dotted, under the body: `definition.resources.connectors.1`. */
  readonly path: string;
  readonly reason: string;
}

/** The agent {@link agentFromVersionBody} rebuilt, and what it took from the project. */
export interface AgentFromVersionBody {
  /** Made by `defineAgent()`, instructions inline (the body's text). */
  readonly agent: DefinedAgent;
  /** Each tool of `agent.tools` that comes from a module, in `agent.tools` order. */
  readonly imports: readonly {
    readonly kind: 'openapi' | 'postgres' | 'code';
    readonly name: string;
    readonly module: string;
    readonly exportName: string;
  }[];
  /** The `agent-workspace.yaml` `connectors:` entries the agent's `mcp()` tools need, verbatim. */
  readonly connectors: Readonly<Record<string, ProjectConnector>>;
}

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The tools a set of evaluated modules export: every `openapiTool()`, `postgresTool()` and
 * `defineTool()` value, sorted by module path, then export name. Pure: the caller evaluates the
 * modules, as aw's loader does, and passes each namespace.
 */
export function toolModulesOf(
  modules: readonly {
    readonly path: string;
    readonly namespace: Readonly<Record<string, unknown>>;
  }[],
): readonly ToolModuleExport[] {
  const exported: ToolModuleExport[] = [];
  for (const { path, namespace } of [...modules].sort((a, b) => byText(a.path, b.path))) {
    for (const exportName of Object.keys(namespace).sort(byText)) {
      const tool = namespace[exportName];
      if (isOpenApiTool(tool) || isPostgresTool(tool) || isCodeTool(tool)) {
        exported.push({ module: path, exportName, tool });
      }
    }
  }
  return exported;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The dotted paths where two parsed bodies differ; a missing key and an extra key both count. */
function differences(left: unknown, right: unknown, path: string): string[] {
  const child = (key: string) => (path === '' ? key : `${path}.${key}`);
  if (isRecord(left) && isRecord(right)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
      differences(left[key], right[key], child(key)),
    );
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    return Array.from({ length }, (_, index) =>
      differences(left[index], right[index], child(String(index))),
    ).flat();
  }
  return Object.is(left, right) ? [] : [path];
}

type CodeToolExport = ToolModuleExport & { readonly tool: CodeTool };

/** An export that repeats the name of an earlier one: the earlier one is used, this one is ignored. */
interface IgnoredToolExport {
  /** The position of the ignored export in `toolModules`. */
  readonly index: number;
  readonly name: string;
  readonly ignored: ToolModuleExport;
  readonly used: ToolModuleExport;
}

function moduleToolsByName(toolModules: readonly ToolModuleExport[]): {
  readonly byName: ReadonlyMap<string, ToolModuleExport>;
  readonly codeByName: ReadonlyMap<string, CodeToolExport>;
  readonly ignored: readonly IgnoredToolExport[];
} {
  const byName = new Map<string, ToolModuleExport>();
  const codeByName = new Map<string, CodeToolExport>();
  const ignored: IgnoredToolExport[] = [];
  for (const [index, entry] of toolModules.entries()) {
    const tool: unknown = entry.tool;
    if (!isOpenApiTool(tool) && !isPostgresTool(tool) && !isCodeTool(tool)) {
      throw new DefinitionError(SUBJECT, [
        {
          path: `toolModules.${index}.tool`,
          message: 'must be made by openapiTool(), postgresTool() or defineTool()',
        },
      ]);
    }
    const name = isCodeTool(tool) ? tool.name : toolNameOf(tool);
    const used = isCodeTool(tool) ? codeByName.get(name) : byName.get(name);
    if (used === undefined) {
      if (isCodeTool(tool)) codeByName.set(name, { ...entry, tool });
      else byName.set(name, entry);
    } else if (used.tool !== tool) {
      // The same tool exported under two names is one tool, not a clash.
      ignored.push({ index, name, ignored: entry, used });
    }
  }
  return { byName, codeByName, ignored };
}

/**
 * A repeated name matters only when the body uses it: another agent's tool may repeat freely.
 * The first export in path order is used, so the report names it.
 */
function reportIgnoredExports(
  ignored: readonly IgnoredToolExport[],
  usedNames: ReadonlySet<string>,
  drop: (path: string, reason: string) => void,
): void {
  for (const { index, name, ignored: entry, used } of ignored) {
    if (!usedNames.has(name)) continue;
    drop(
      `toolModules.${index}`,
      `${name}: ${entry.module}#${entry.exportName} repeats the name of ${used.module}#${used.exportName}, which is used; rename one of them`,
    );
  }
}

/** What {@link pinnedOf} reads of a code tool: the fields of `defineTool()` a bundle pins. */
export interface PinnableCodeTool {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly limits: { readonly timeoutMs: number };
  readonly secrets?: readonly string[] | undefined;
  readonly allowedDomains?: readonly string[] | undefined;
}

/** A code tool's declaration in the shape a version's `toolBundles` entry pins it, without `tool` and `digest`. */
export type PinnedToolDeclaration = Omit<AgentVersionToolBundle, 'tool' | 'digest'>;

/**
 * The declaration `aw push` pins for a code tool in a version's `toolBundles` entry: the fields a
 * hosted sandbox serves (ADR-0118 TS1, TS4, TS5). An absent optional field stays absent, so the
 * result compares equal to the entry the server stored.
 */
export function pinnedOf(tool: PinnableCodeTool): PinnedToolDeclaration {
  return {
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    timeoutMs: tool.limits.timeoutMs,
    ...(tool.secrets === undefined ? {} : { secrets: tool.secrets }),
    ...(tool.allowedDomains === undefined ? {} : { allowedDomains: tool.allowedDomains }),
  };
}

/**
 * The code tools to write at `aw-dev-tools`, in `names` order, and a reason for each name that
 * cannot be written. A pinned bundle that disagrees is reported through `drop`, and its tool is
 * left out.
 */
function resolveCodeTools(
  names: readonly string[] | undefined,
  given: readonly string[] | undefined,
  hasSlot: boolean,
  bundles: AgentVersionBody['toolBundles'],
  codeByName: ReadonlyMap<string, CodeToolExport>,
  clash: (name: string) => { readonly path?: string; readonly why: string } | undefined,
  drop: (path: string, reason: string) => void,
): { readonly found: CodeToolExport[]; readonly problems: string[] } {
  if (names === undefined) {
    return { found: [], problems: ['code tools need codeToolNames or toolBundles'] };
  }
  if (!hasSlot && (given?.length ?? 0) > 0) drop('codeToolNames', 'the body has no code tools');
  const unpinned = new Set<string>();
  const reject = (path: string, name: string, why: string) => {
    drop(path, `${name}: ${why}`);
    unpinned.add(name);
  };
  for (const [index, bundle] of (bundles ?? []).entries()) {
    const entry = codeByName.get(bundle.tool);
    if (!names.includes(bundle.tool)) {
      reject(`toolBundles.${index}`, bundle.tool, 'codeToolNames does not name it');
    } else if (
      // The digest is not compared; a bundle with only a name and digest predates declarations.
      entry !== undefined &&
      Object.keys(bundle).some((key) => key !== 'tool' && key !== 'digest') &&
      differences(
        { ...bundle, digest: undefined },
        { tool: bundle.tool, ...pinnedOf(entry.tool), digest: undefined },
        '',
      ).length > 0
    ) {
      reject(
        `toolBundles.${index}`,
        bundle.tool,
        "it pins another declaration than the module's tool",
      );
    }
  }
  const found: CodeToolExport[] = [];
  const problems: string[] = [];
  const named = new Set<string>();
  for (const [index, name] of names.entries()) {
    const entry = codeByName.get(name);
    const where = given !== undefined ? 'codeToolNames' : 'toolBundles';
    const conflict = clash(name);
    if (named.has(name)) {
      drop(`${where}.${index}`, `${name}: it repeats an earlier code tool`);
      continue;
    }
    named.add(name);
    if (conflict !== undefined) {
      drop(conflict.path ?? `${where}.${index}`, `${name}: ${conflict.why}`);
    } else if (bundles !== undefined && !bundles.some(({ tool }) => tool === name)) {
      reject('toolBundles', name, 'it has no pinned bundle');
    } else if (entry === undefined) {
      problems.push(`code tool ${name} is exported by no module with defineTool()`);
    } else if (!unpinned.has(name)) found.push(entry);
  }
  // Without a reason at aw-dev-tools, the self-check would cascade over every later connector.
  if (found.length === 0 && problems.length === 0) {
    problems.push('no code tool is left to write (see the earlier drops)');
  }
  return { found, problems };
}

function engineSettingsFor(
  policy: AgentVersionBody['definition']['policy'],
  permissions: AgentVersionBody['definition']['agent']['permissions'],
): Record<string, unknown> {
  if (!('tools' in policy)) return { ...engineSettingsOf(policy) };
  // A stored rule for a tool the permissions turn off would make defineAgent() refuse the input;
  // leaving it out lets the self-check report it at its policy path instead.
  const denied = new Set(claudeDeniedToolsFor(permissions));
  const allowed = (rule: string) => !denied.has(rule.split('(', 1)[0] ?? rule);
  const autoApprove = policy.tools.autoApprove.filter(allowed);
  const requireApproval = policy.requireApproval?.filter(allowed);
  return {
    ...(autoApprove.length > 0 ? { autoApprove } : {}),
    ...(requireApproval === undefined ? {} : { requireApproval }),
    ...(policy.handoff === true ? { handoff: true } : {}),
  };
}

/**
 * Why `defineAgent()` cannot reproduce a body field, for the fields a person can act on; the
 * others get the generic reason.
 */
function selfCheckReason(path: string, body: AgentVersionBody): string {
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}.`);
  if (under('definition.agent.runtimeProfileName')) {
    return `the runtime profile "${body.definition.agent.runtimeProfileName ?? ''}" is an Agent Workspace resource defineAgent() cannot name; switch it with aw agents update`;
  }
  if (under('definition.policy.skills')) {
    return 'defineAgent() writes no skill allowlist, so every assigned skill stays allowed; set the allowlist with aw agents policy set';
  }
  if (under('definition.policy.tools')) {
    return 'defineAgent() writes the base tool policy plus engine.autoApprove only; set any other tool rule with aw agents policy set';
  }
  return 'not reproduced by defineAgent()';
}

/**
 * The inverse of {@link toAgentVersionBody} for an Agent Workspace project: the agent a body came
 * from, with what the body only names taken from the project. Nothing is left out silently.
 *
 * - Every `resources.files` grant becomes `files(path, access)`, in body order, including those
 *   knowledge implied, so `toAgentVersionBody()` appends nothing and gives the same list.
 * - Each `resources.connectors` name becomes the tool a module exports under that name (the
 *   exact value, so spec, `allow`, auth and `identity` survive; `imports` says which module), or
 *   `mcp(name)` when `project.connectors` has the name (its entry is returned in `connectors`).
 * - `aw-dev-tools` becomes the code tools `source.codeToolNames` names (else `body.toolBundles`,
 *   in the bundles' name order), each the `defineTool()` export of that name, expanded in place.
 *   A bundle that pins another declaration than the module's tool, or that `codeToolNames` does
 *   not name, is dropped at `toolBundles.N` with its tool; so is a named tool with no bundle.
 *   `digest` is not compared: the SDK has no bundle bytes, and push pins it again. A bundle with
 *   no declaration (written before hosted sandboxes) matches by name.
 *   A repeated name, a name that a connector or module tool also has, and `codeToolNames` for a
 *   body with no `aw-dev-tools` are drops too (`codeToolNames.N`, the connector entry, `codeToolNames`).
 * - Two module exports of one name: the first, in path order, is used. When the body uses the
 *   name, the other is a drop at `toolModules.N`; the same tool exported twice is not.
 * - A name no module and no connector supplies (an inline tool looks the same), a name both
 *   supply (push refuses a tool with a connector's name), and code tools no source names or no
 *   module exports are drops.
 * - Last, the agent goes through `toAgentVersionBody()` again and the result is compared with
 *   the body, `toolBundles` aside: every differing path no drop covers becomes a drop, so a body
 *   field `defineAgent()` cannot write is reported at its path, with the reason a person acts on
 *   for a runtime profile, a skill allowlist and a stored tool policy.
 * - The body does not record where a code tool stood among the other tools, only that
 *   `aw-dev-tools` did, so the code tools come back together at that position (keeping their order
 *   relative to the other tools needs a contract change).
 * - `toolBundles` pin code tools only: a catalog tool (`openapiTool()`, `postgresTool()`) is
 *   registered at push time and the body holds its name alone, so its declaration is not compared.
 *
 * @throws {DefinitionError} when the body, a module's tool or what `defineAgent()` is given is
 *   refused, or a surface is not made by `defineSurface()`.
 */
export function agentFromVersionBody(source: AgentVersionSource): {
  readonly value: AgentFromVersionBody;
  readonly dropped: readonly VersionBodyDrop[];
} {
  const parsedBody = AgentVersionBodySchema.safeParse(source.body);
  if (!parsedBody.success) {
    throw new DefinitionError(SUBJECT, issuesFromZod(parsedBody.error, 'body'));
  }
  const bundles = parsedBody.data.toolBundles;
  const body = { ...parsedBody.data, toolBundles: undefined };
  const { agent, policy, resources } = body.definition;
  const project = source.project ?? {};
  const surfaces = source.surfaces ?? [];
  const dropped: VersionBodyDrop[] = [];
  const drop = (path: string, reason: string) => dropped.push({ path, reason });

  const {
    byName: fromModule,
    codeByName: codeFromModule,
    ignored,
  } = moduleToolsByName(source.toolModules ?? []);
  const codeToolNames = source.codeToolNames ?? bundles?.map(({ tool }) => tool);
  reportIgnoredExports(ignored, new Set([...resources.connectors, ...(codeToolNames ?? [])]), drop);
  const code = resolveCodeTools(
    codeToolNames,
    source.codeToolNames,
    resources.connectors.includes(AW_DEV_TOOLS_CONNECTOR),
    bundles,
    codeFromModule,
    (name) => {
      const index = resources.connectors.indexOf(name);
      if (index >= 0 && name !== AW_DEV_TOOLS_CONNECTOR) {
        return {
          path: `definition.resources.connectors.${index}`,
          why: 'a code tool cannot share its name with a connector; push refuses it',
        };
      }
      return fromModule.has(name) || Object.hasOwn(project.connectors ?? {}, name)
        ? {
            why: 'a code tool cannot share its name with a module tool or connector; push refuses it',
          }
        : undefined;
    },
    drop,
  );

  const tools: DefineTool[] = [];
  const imports: AgentFromVersionBody['imports'][number][] = [];
  const connectors: Record<string, ProjectConnector> = {};
  for (const [index, name] of resources.connectors.entries()) {
    const path = `definition.resources.connectors.${index}`;
    const entry = fromModule.get(name);
    const connector = Object.hasOwn(project.connectors ?? {}, name)
      ? project.connectors?.[name]
      : undefined;
    if (name === AW_DEV_TOOLS_CONNECTOR) {
      for (const reason of code.problems) drop(path, reason);
      for (const { tool, module, exportName } of code.found) {
        tools.push(tool);
        imports.push({ kind: 'code', name: tool.name, module, exportName });
      }
    } else if (entry !== undefined && connector !== undefined) {
      drop(path, `${name} is a module tool and a connectors: entry; push refuses that (SD1)`);
    } else if (entry !== undefined) {
      tools.push(entry.tool);
      imports.push({
        kind: isOpenApiTool(entry.tool) ? 'openapi' : 'postgres',
        name,
        module: entry.module,
        exportName: entry.exportName,
      });
    } else if (connector !== undefined) {
      tools.push(mcp(name));
      connectors[name] = connector;
    } else {
      drop(
        path,
        `${name} is in no module and no connectors: entry: declare it in a module under tools/ or add a connectors: entry`,
      );
    }
  }

  const settings = engineSettingsFor(policy, agent.permissions);
  const limits = Object.fromEntries(
    Object.entries(policy.limits).filter(([, value]) => value !== null),
  );
  const revisions = resources.skillRevisions ?? {};
  const checked = DefineAgentInputSchema.safeParse({
    name: agent.name,
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.subagents === undefined
      ? {}
      : { subagents: body.subagents.map((subagent) => subagent.name) }),
    ...(body.knowledge === undefined
      ? {}
      : {
          // A connector source whose mcp() tool was dropped would make defineAgent() refuse the
          // input; leaving it out lets the self-check report it at its knowledge path instead.
          knowledge: body.knowledge.filter(
            (source) => source.kind !== 'connector' || Object.hasOwn(connectors, source.name),
          ),
        }),
    instructions: agent.instructions,
    model:
      agent.model === null
        ? agent.modelConnectionName
        : { connection: agent.modelConnectionName, id: agent.model },
    ...(policy.engine === (project.engine ?? DEFAULT_ENGINE_ID) &&
    Object.keys(settings).length === 0
      ? {}
      : { engine: { id: policy.engine, ...settings } }),
    permissions: agent.permissions,
    tools,
    skills: resources.skills.map((name) =>
      skill(name, Object.hasOwn(revisions, name) ? { revision: revisions[name] } : {}),
    ),
    files: resources.files.map((grant) => files(grant.path, grant.access)),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
  });
  if (!checked.success) {
    throw new DefinitionError(SUBJECT, issuesFromZod(checked.error, 'agent'));
  }
  const rebuilt = defineAgent(checked.data);

  const again = {
    ...AgentVersionBodySchema.parse(
      toAgentVersionBody(rebuilt, { surfaces, defaultEngine: project.engine }),
    ),
    toolBundles: undefined,
  };
  const covered = dropped.map(({ path }) => path.replace(/\.\d+$/u, ''));
  for (const path of differences(body, again, '')) {
    if (!covered.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) {
      drop(path, selfCheckReason(path, body));
    }
  }

  return Object.freeze({
    value: Object.freeze({
      agent: rebuilt,
      imports: Object.freeze(imports),
      connectors: Object.freeze(connectors),
    }),
    dropped: Object.freeze(dropped),
  });
}
