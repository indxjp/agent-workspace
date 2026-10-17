import {
  connectorKindOf,
  isMcpConnectorResource,
  type ConnectorAuthType,
  type ConnectorResource,
  type CreateConnectorInput,
  type UpdateConnectorInput,
} from '@indx-workspace/contracts/connectors';
import {
  MODEL_CONNECTION_CONFIG_FIELDS,
  type CreateModelConnectionInput,
  type ModelConnectionConfigInput,
  type ModelConnectionResource,
  type UpdateModelConnectionPatch,
} from '@indx-workspace/contracts/models';
import type {
  ProjectDocument,
  ProjectModelConnection,
} from '@indx-workspace/contracts/project-file';
import type { SkillFile } from '@indx-workspace/contracts/skills';
import { POSTGRES_DEFAULT_MAX_ROWS } from '@indx-workspace/contracts/tool-connectors';

import type { OpenApiToolDefinition, PostgresToolDefinition } from '../define/index.js';
import type { ToolConnectorBody } from '../resources/connectors.js';

/**
 * One catalog tool to register, from `toolDefinitionsOf()`. An `openapi` tool also carries the
 * document text the caller read from its `spec`, and `digest`, `sha256:<hex>` over that text's
 * UTF-8 bytes, which the plan compares with the saved document's.
 */
export type PlannedTool =
  | {
      readonly definition: OpenApiToolDefinition;
      readonly document: string;
      readonly digest: string;
    }
  | { readonly definition: PostgresToolDefinition };

/**
 * What the caller knows of one secret (SD16): the fingerprint of its value now, and the one
 * recorded when it was last sent, absent when none was recorded. Never the value.
 */
export interface PlanSecret {
  readonly fingerprint: string;
  readonly sentFingerprint?: string;
}

/**
 * One `skills/<name>/` folder of the project, read by the caller (this module reads no file).
 * `hash` is the caller's digest of the sorted file paths and bytes; the plan only compares it with
 * the workspace skill's.
 */
export interface ProjectSkill {
  readonly name: string;
  readonly files: readonly SkillFile[];
  readonly hash: string;
}

/** A workspace skill's name and the same digest of its exported files. */
export interface ExistingSkill {
  readonly name: string;
  readonly hash: string;
}

/** What {@link planProjectResources} reads; every field is already schema-parsed. */
export interface PlanProjectResourcesInput {
  /** The v2 project file, as `parseProjectFile` returns it. */
  readonly project: ProjectDocument;
  /** The catalog tools of the project's agents, each name once. */
  readonly tools: readonly PlannedTool[];
  /** The workspace's connections and connectors, as the client lists them. */
  readonly existing: {
    readonly modelConnections: readonly ModelConnectionResource[];
    readonly connectors: readonly ConnectorResource[];
    /** The workspace's skills; left out, none exist. */
    readonly skills?: readonly ExistingSkill[];
  };
  /** The project's `skills/<name>/` folders; left out, none. */
  readonly skills?: readonly ProjectSkill[];
  /**
   * Every secret whose variable is set, by name; a missing name is an unset variable. That is every
   * secret the project or a tool declares, plus `ANTHROPIC_API_KEY` when the project has no `models` (C6).
   */
  readonly secrets: ReadonlyMap<string, PlanSecret>;
  /** `ANTHROPIC_BASE_URL`, used only for the C6 `default` connection. */
  readonly anthropicBaseUrl?: string;
  /**
   * The `ANTHROPIC_BASE_URL` recorded when the C6 `default` connection last took it (issue #732):
   * `null` when it was unset then, absent when nothing was recorded.
   */
  readonly sentAnthropicBaseUrl?: string | null;
}

/** `T` without its `credential`, for each member of a union. */
type WithoutCredential<T> = T extends unknown ? Omit<T, 'credential'> : never;

/**
 * A resource to create. `secret` names the variable whose value the caller sends with it: as
 * `apiKey` for a model connection, as `credential` for a connector.
 */
export type ProjectResourceCreate =
  | {
      readonly kind: 'model';
      readonly path: string;
      readonly input: Omit<CreateModelConnectionInput, 'apiKey'>;
      readonly secret: string;
    }
  | {
      readonly kind: 'connector';
      readonly path: string;
      readonly input: WithoutCredential<CreateConnectorInput | ToolConnectorBody>;
      readonly secret?: string;
    };

/**
 * A change to an existing resource, by id. `model-credential` and `connector-credential` rotate
 * the credential alone from the named variable; a `connector` patch with `secret` sends that
 * variable's value as its `credential`, and a `model` patch sends it as its `apiKey` (a new
 * `baseUrl` needs the key in the same request). There is no delete.
 */
export type ProjectResourceUpdate =
  | {
      readonly kind: 'model';
      readonly path: string;
      readonly id: string;
      readonly patch: Omit<UpdateModelConnectionPatch, 'apiKey'>;
      readonly secret: string;
    }
  | {
      readonly kind: 'model-credential';
      readonly path: string;
      readonly id: string;
      readonly secret: string;
    }
  | {
      readonly kind: 'connector';
      readonly path: string;
      readonly id: string;
      readonly patch: WithoutCredential<UpdateConnectorInput | ToolConnectorBody>;
      readonly secret?: string;
    }
  | {
      readonly kind: 'connector-credential';
      readonly path: string;
      readonly id: string;
      readonly secret: string;
    };

/** A refusal or a notice, at a dotted project path. It names secrets, never their values. */
export interface ProjectResourceIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * What to do with one project skill folder: create the workspace skill, update it (the content
 * hash differs), or leave it. Kept apart from `creates` and `updates`, whose consumers handle
 * only connections and connectors.
 */
export interface ProjectSkillAction {
  readonly action: 'create' | 'update' | 'unchanged';
  readonly path: string;
  readonly name: string;
  readonly files: readonly SkillFile[];
  readonly hash: string;
}

/** What `aw dev` does to make the workspace match the project: see {@link planProjectResources}. */
export interface ProjectResourcePlan {
  /** One entry per `skills/<name>/` folder, in the order given. */
  readonly skills: readonly ProjectSkillAction[];
  readonly creates: readonly ProjectResourceCreate[];
  readonly updates: readonly ProjectResourceUpdate[];
  readonly refusals: readonly ProjectResourceIssue[];
  readonly notices: readonly ProjectResourceIssue[];
}

interface Planning {
  readonly input: PlanProjectResourcesInput;
  readonly creates: ProjectResourceCreate[];
  readonly updates: ProjectResourceUpdate[];
  readonly refusals: ProjectResourceIssue[];
  readonly notices: ProjectResourceIssue[];
}

/** The C6 connection, made from `ANTHROPIC_API_KEY` when the project declares no `models`. */
const DEFAULT_MODEL_CONNECTION = 'default';
const DEFAULT_MODEL_SECRET = 'ANTHROPIC_API_KEY';

/**
 * What to do with a declared secret (C10, SD16): `unset` — a notice is pushed and the resource is
 * skipped; `rotate` — send the value; `keep` — the saved credential is current. A resource still to
 * be created is never `rotate`: its create carries the value.
 */
function secretState(
  planning: Planning,
  path: string,
  name: string,
  existing: { readonly hasCredential: boolean } | undefined,
): 'unset' | 'rotate' | 'keep' {
  const secret = planning.input.secrets.get(name);
  if (secret === undefined) {
    planning.notices.push({
      path,
      message: `${name} is not set: run export ${name}=… in the shell aw dev started from, then restart aw dev`,
    });
    return 'unset';
  }
  if (existing === undefined) return 'keep';
  // No recorded fingerprint counts as changed: the first send records one (SD16).
  // ponytail: fingerprints are keyed by secret name, not by resource; a crash between two sends of
  // one shared secret leaves the second unrotated until its value changes again, upgrade: key the
  // SD16 record by <path>/<NAME>.
  const changed = secret.sentFingerprint !== secret.fingerprint;
  if (existing.hasCredential && changed && secret.sentFingerprint !== undefined) {
    planning.notices.push({ path, message: `${name} changed: rotating the credential` });
  }
  return !existing.hasCredential || changed ? 'rotate' : 'keep';
}

/** The declared config fields of a model connection; an undeclared one is absent. */
function declaredConfig(declared: ProjectModelConnection): ModelConnectionConfigInput {
  const config: { -readonly [Field in keyof ModelConnectionConfigInput]: string } = {};
  for (const field of MODEL_CONNECTION_CONFIG_FIELDS) {
    const value = declared[field];
    if (value !== undefined) config[field] = value;
  }
  return config;
}

/** C11: each declared connection is created, or its config and credential brought in step. */
function planModels(
  planning: Planning,
  models: Readonly<Record<string, ProjectModelConnection>>,
): void {
  for (const [name, declared] of Object.entries(models)) {
    const path = `models.${name}`;
    const current = planning.input.existing.modelConnections.find((c) => c.name === name);
    if (current !== undefined && current.provider !== declared.provider) {
      planning.refusals.push({
        path: `${path}.provider`,
        message: `the connection is ${current.provider} on the server and ${declared.provider} here; a provider cannot change: rename the connection`,
      });
      continue;
    }
    const secret = declared.credential.secret;
    const state = secretState(planning, path, secret, current);
    if (state === 'unset') continue;
    const config = declaredConfig(declared);
    if (current === undefined) {
      const input = { name, provider: declared.provider };
      planning.creates.push({
        kind: 'model',
        path,
        input: Object.keys(config).length === 0 ? input : { ...input, config },
        secret,
      });
      continue;
    }
    if (MODEL_CONNECTION_CONFIG_FIELDS.some((field) => current.config[field] !== config[field])) {
      planning.updates.push({ kind: 'model', path, id: current.id, patch: { config }, secret });
    }
    if (state === 'rotate') {
      planning.updates.push({ kind: 'model-credential', path, id: current.id, secret });
    }
  }
}

/**
 * C6: with no `models`, a missing `default` is created. Issue #732: an existing one is brought in
 * step with `aw dev`'s environment whenever `ANTHROPIC_API_KEY` is set — a changed key rotated
 * (SD16), and the base URL patched only when `ANTHROPIC_BASE_URL` changed since it was recorded (a
 * removed one clears it), so a base URL set elsewhere is not overwritten on every start. With
 * nothing recorded, only a set `ANTHROPIC_BASE_URL` that differs is applied; it never clears. With
 * the key unset the connection is left as it is; the caller says it runs on the key stored earlier.
 */
function planDefaultModel(planning: Planning): void {
  const { existing, secrets, anthropicBaseUrl, sentAnthropicBaseUrl } = planning.input;
  const path = `models.${DEFAULT_MODEL_CONNECTION}`;
  const current = existing.modelConnections.find((c) => c.name === DEFAULT_MODEL_CONNECTION);
  if (current !== undefined) {
    if (!secrets.has(DEFAULT_MODEL_SECRET) || current.provider !== 'anthropic') return;
    const changed =
      sentAnthropicBaseUrl === undefined
        ? anthropicBaseUrl !== undefined
        : sentAnthropicBaseUrl !== (anthropicBaseUrl ?? null);
    if (changed && current.config.baseUrl !== anthropicBaseUrl) {
      const config = anthropicBaseUrl === undefined ? {} : { baseUrl: anthropicBaseUrl };
      planning.updates.push({
        kind: 'model',
        path,
        id: current.id,
        patch: { config },
        secret: DEFAULT_MODEL_SECRET,
      });
      // The host only: a URL may carry a path or user info that is not for the log.
      const to =
        anthropicBaseUrl === undefined
          ? 'cleared to the provider default'
          : `updated to ${URL.canParse(anthropicBaseUrl) ? new URL(anthropicBaseUrl).host : 'a new URL'}`;
      planning.notices.push({ path, message: `ANTHROPIC_BASE_URL changed: base URL ${to}` });
    }
    if (secretState(planning, path, DEFAULT_MODEL_SECRET, current) === 'rotate') {
      planning.updates.push({
        kind: 'model-credential',
        path,
        id: current.id,
        secret: DEFAULT_MODEL_SECRET,
      });
    }
    return;
  }
  if (!secrets.has(DEFAULT_MODEL_SECRET)) {
    planning.notices.push({
      path,
      message: `no "${DEFAULT_MODEL_CONNECTION}" model connection yet; set ${DEFAULT_MODEL_SECRET} and restart aw dev to create one`,
    });
    return;
  }
  const input = { name: DEFAULT_MODEL_CONNECTION, provider: 'anthropic' } as const;
  planning.creates.push({
    kind: 'model',
    path,
    input:
      anthropicBaseUrl === undefined ? input : { ...input, config: { baseUrl: anthropicBaseUrl } },
    secret: DEFAULT_MODEL_SECRET,
  });
}

/** How a refusal names an existing connector: its transport for MCP, else its kind. */
function connectorLabel(connector: ConnectorResource): string {
  return isMcpConnectorResource(connector) ? connector.transport : connectorKindOf(connector);
}

/** C10: each declared MCP connector is created, or its URL, auth and credential brought in step. */
function planConnectors(
  planning: Planning,
  connectors: NonNullable<ProjectDocument['connectors']>,
): void {
  for (const [name, declared] of Object.entries(connectors)) {
    const path = `connectors.${name}`;
    const transport = declared.transport ?? 'http';
    const current = planning.input.existing.connectors.find((c) => c.name === name);
    if (
      current !== undefined &&
      (!isMcpConnectorResource(current) || current.transport !== transport)
    ) {
      planning.refusals.push({
        path,
        message: `a connector of this name exists as ${connectorLabel(current)}, not ${transport}; rename one`,
      });
      continue;
    }
    const secret = declared.auth?.credential.secret;
    const state = secret === undefined ? 'keep' : secretState(planning, path, secret, current);
    if (state === 'unset') continue;
    const withSecret = secret === undefined ? {} : { secret };
    if (current === undefined) {
      const input = { name, transport, url: declared.url };
      planning.creates.push({
        kind: 'connector',
        path,
        input: declared.auth === undefined ? input : { ...input, authType: declared.auth.scheme },
        ...withSecret,
      });
      continue;
    }
    const authType: ConnectorAuthType = declared.auth?.scheme ?? 'none';
    const patch = {
      ...(current.url === declared.url ? {} : { url: declared.url }),
      ...(current.authType === authType ? {} : { authType }),
    };
    if (Object.keys(patch).length > 0) {
      planning.updates.push({ kind: 'connector', path, id: current.id, patch, ...withSecret });
    } else if (state === 'rotate' && secret !== undefined) {
      planning.updates.push({ kind: 'connector-credential', path, id: current.id, secret });
    }
  }
}

/**
 * The connector create body of a planned tool, without its credential, which the caller adds from
 * the secret the definition names. The same body {@link planProjectResources} puts in a tool's
 * create or update.
 */
export function toolConnectorBody(tool: PlannedTool): WithoutCredential<ToolConnectorBody> {
  if ('document' in tool) {
    const { definition } = tool;
    return {
      kind: 'openapi',
      name: definition.name,
      document: tool.document,
      ...(definition.baseUrl === undefined ? {} : { baseUrl: definition.baseUrl }),
      allow: definition.allow,
      auth: definition.auth,
    };
  }
  const { definition } = tool;
  return {
    kind: 'postgres',
    name: definition.name,
    tables: definition.tables,
    readOnly: true,
    ...(definition.maxRows === undefined ? {} : { maxRows: definition.maxRows }),
  };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Whether the saved tool differs from the declared one. An undeclared `baseUrl` is the document's
 * first server (SD15), which the digest already covers.
 */
function toolDiffers(tool: PlannedTool, current: ConnectorResource): boolean {
  if ('document' in tool) {
    const { definition } = tool;
    const saved = current.openapi;
    if (saved === undefined) return true;
    const sameAuth =
      typeof definition.auth === 'string' || typeof saved.auth === 'string'
        ? definition.auth === saved.auth
        : definition.auth.header === saved.auth.header;
    return (
      tool.digest !== saved.spec.digest ||
      !sameList(definition.allow, saved.allow) ||
      !sameAuth ||
      (definition.baseUrl !== undefined && definition.baseUrl !== saved.baseUrl)
    );
  }
  const saved = current.postgres;
  if (saved === undefined) return true;
  return (
    !sameList(tool.definition.tables, saved.tables) ||
    (tool.definition.maxRows ?? POSTGRES_DEFAULT_MAX_ROWS) !== saved.maxRows
  );
}

/** C15: each tool is created, or registered again with its whole body when anything differs. */
function planTools(planning: Planning): void {
  const declaredConnectors = planning.input.project.connectors ?? {};
  for (const tool of planning.input.tools) {
    const { name, kind } = tool.definition;
    const path = `tools.${name}`;
    if (Object.hasOwn(declaredConnectors, name)) {
      planning.refusals.push({
        path,
        message: `connectors.${name} declares this name too; tools and connectors share one namespace: rename one`,
      });
      continue;
    }
    const current = planning.input.existing.connectors.find((c) => c.name === name);
    if (current !== undefined && connectorKindOf(current) !== kind) {
      planning.refusals.push({
        path,
        message: `a connector of this name exists as ${connectorLabel(current)}, not ${kind}; rename one`,
      });
      continue;
    }
    const secret = tool.definition.credential?.secret;
    const state = secret === undefined ? 'keep' : secretState(planning, path, secret, current);
    if (state === 'unset') continue;
    const withSecret = secret === undefined ? {} : { secret };
    if (current === undefined) {
      planning.creates.push({
        kind: 'connector',
        path,
        input: toolConnectorBody(tool),
        ...withSecret,
      });
    } else if (state === 'rotate' || toolDiffers(tool, current)) {
      planning.updates.push({
        kind: 'connector',
        path,
        id: current.id,
        patch: toolConnectorBody(tool),
        ...withSecret,
      });
    }
  }
}

/** Each skill folder is created, updated when its hash differs from the workspace's, or unchanged. */
export function planProjectSkills(input: {
  readonly skills?: readonly ProjectSkill[] | undefined;
  readonly existing?: readonly ExistingSkill[] | undefined;
}): readonly ProjectSkillAction[] {
  const saved = new Map((input.existing ?? []).map((skill) => [skill.name, skill.hash]));
  return (input.skills ?? []).map(({ name, files, hash }) => {
    const current = saved.get(name);
    const action = current === undefined ? 'create' : current === hash ? 'unchanged' : 'update';
    return { action, path: `skills.${name}`, name, files, hash };
  });
}

/**
 * What `aw dev` creates, updates, refuses and reports to bring the workspace in step with the
 * project file and its agents' tools (C10, C11, C15, SD16). Pure and synchronous: it reads nothing
 * but its input, which is already schema-parsed, so it does not validate it again.
 *
 * - **No secret value.** An action names its secret; the caller reads the value, sends it, and
 *   records its fingerprint. An unset secret is a notice, and its resource is skipped.
 * - **Rotation.** A credential is sent again when the server has none or when its fingerprint
 *   differs from the one recorded at the last send; no recorded one counts as different.
 * - **Never deletes.** A resource the project does not declare is left alone.
 * - **Models.** With `models`, each is created or its config and credential updated; a provider
 *   cannot change, so a mismatch is a refusal. Without, a missing `default` is created from
 *   `ANTHROPIC_API_KEY` (C6), and an existing one follows that key and `ANTHROPIC_BASE_URL` (#732).
 * - **Connectors and tools** share one namespace (SD1): a name of another kind or transport is a
 *   refusal. A tool is updated with its whole create body, credential included.
 *
 * - **Skills.** Each `skills/<name>/` folder is a `skills` entry: created, updated when its content
 *   hash differs, else unchanged. A workspace skill with no folder is left alone.
 *
 * Actions come in the order declared: models, connectors, then tools.
 */
export function planProjectResources(input: PlanProjectResourcesInput): ProjectResourcePlan {
  const planning: Planning = { input, creates: [], updates: [], refusals: [], notices: [] };
  if (input.project.models === undefined) planDefaultModel(planning);
  else planModels(planning, input.project.models);
  planConnectors(planning, input.project.connectors ?? {});
  planTools(planning);
  const { creates, updates, refusals, notices } = planning;
  return {
    creates,
    updates,
    refusals,
    notices,
    skills: planProjectSkills({ skills: input.skills, existing: input.existing.skills }),
  };
}
