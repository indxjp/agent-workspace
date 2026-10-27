import { z } from 'zod';

import {
  ToolAllowedDomainsSchema,
  ToolSecretNamesSchema,
} from '@indx-workspace/contracts/agent-versions';
import {
  AGENT_DEFINITION_FILE_PATH_MAX_LENGTH,
  AgentDefinitionResourcesSchema,
} from '@indx-workspace/contracts/agents';
import {
  SecretNameSchema,
  SecretReferenceSchema,
  type SecretReference,
} from '@indx-workspace/contracts/secret-reference';
import {
  BUILTIN_SKILL_NAMES,
  SkillRevisionNumberSchema,
  type BuiltinSkillName,
} from '@indx-workspace/contracts/skills';
import {
  CreateOpenApiConnectorRequestSchema,
  CreatePostgresConnectorRequestSchema,
  OpenApiAllowSchema,
  OpenApiAuthSchema,
  PostgresMaxRowsSchema,
  PostgresTablesSchema,
  TOOL_OPERATION_PATH_MAX_LENGTH,
  ToolOperationNameSchema,
} from '@indx-workspace/contracts/tool-connectors';

import { brand, hasBrand, type Branded } from './brand.js';
import { DefinitionError, issuesFromZod } from './errors.js';

/**
 * The leaf schemas of a definition's `resources`, read from the contract rather than retyped, so
 * a reference `mcp()`, `skill()` or `files()` accepts is one `AgentDefinitionSchema` accepts.
 */
const RESOURCES_SHAPE = AgentDefinitionResourcesSchema.unwrap().shape;
const ConnectorNameSchema = RESOURCES_SHAPE.connectors.unwrap().element;
const SkillNameSchema = RESOURCES_SHAPE.skills.unwrap().element;
export const FileGrantSchema = RESOURCES_SHAPE.files.unwrap().element;

/** How an agent may use a granted file: `read`, or `read-write`. */
export type FileAccess = z.infer<typeof FileGrantSchema>['access'];

/**
 * An MCP connector the agent may call, by the connector's name in the workspace. Made by
 * {@link mcp}; it lands in the version's `resources.connectors`.
 */
export interface McpTool extends Branded<'mcp'> {
  readonly connector: string;
}

/**
 * A skill the agent may use, by name. Made by {@link skill}; it lands in the version's
 * `resources.skills` and in the policy's skill allowlist, and a pinned `revision` in its
 * `resources.skillRevisions`.
 */
export interface SkillReference extends Branded<'skill'> {
  readonly name: string;
  readonly revision?: number | undefined;
}

/** What {@link skill} accepts beyond the name. */
export interface SkillOptions {
  /**
   * Pins the skill to this published revision (`aw skills publish` numbers them from 1) instead of
   * following its current files.
   */
  readonly revision?: number | undefined;
}

const SkillOptionsSchema = z.object({ revision: SkillRevisionNumberSchema.optional() }).strict();

/**
 * A workspace file the agent may read, or read and write. Made by {@link files}; it lands in the
 * version's `resources.files`.
 */
export interface FileGrant extends Branded<'files'> {
  readonly path: string;
  readonly access: FileAccess;
}

function parsed<T>(subject: string, result: z.ZodSafeParseResult<T>): T {
  if (!result.success) throw new DefinitionError(subject, issuesFromZod(result.error));
  return result.data;
}

/**
 * Gives the agent an MCP connector as a tool, by the connector's name (1–200 characters) in the
 * workspace the agent is pushed to. The name is resolved when the version is saved; a name the
 * workspace does not have is refused there.
 *
 * @throws {DefinitionError} when the name is empty or too long.
 */
export function mcp(connector: string): McpTool {
  return brand({ connector: parsed('mcp()', ConnectorNameSchema.safeParse(connector)) }, 'mcp');
}

/**
 * Assigns a skill to the agent, by name: lower-case letters, digits and inner hyphens, at most 64
 * characters, as the workspace's skill names are written. Without `options.revision` the agent
 * follows the skill's current files; with it, the version pins that immutable revision, which must
 * be published before the version is saved.
 *
 * @throws {DefinitionError} when the name is not a skill name, or `options.revision` is not an
 *   integer of at least 1 (or `options` has another key).
 */
export function skill(name: string, options: SkillOptions = {}): SkillReference {
  const { revision } = parsed('skill()', SkillOptionsSchema.safeParse(options));
  return brand(
    {
      name: parsed('skill()', SkillNameSchema.safeParse(name)),
      ...(revision === undefined ? {} : { revision }),
    },
    'skill',
  );
}

/**
 * Assigns a skill the platform ships with every workspace (`'office-reader'`: xlsx, docx, PDF and
 * ASCII DXF to text). It is the same reference as {@link skill}; the control plane installs the
 * skill's files into the workspace when a version naming it is saved, so no code or import is
 * needed.
 *
 * @throws {DefinitionError} when the name is not a built-in skill.
 */
export function builtinSkill(name: BuiltinSkillName): SkillReference {
  if (!BUILTIN_SKILL_NAMES.includes(name))
    throw new DefinitionError('builtinSkill()', [
      {
        path: '(root)',
        message: `${JSON.stringify(name)} is not a built-in skill; use one of ${BUILTIN_SKILL_NAMES.join(', ')}`,
      },
    ]);
  return skill(name);
}

/**
 * Grants the agent a workspace file by its path (1–1024 characters), read-only unless `access`
 * is `'read-write'`.
 *
 * @throws {DefinitionError} when the path is empty or too long, or `access` is not an access mode.
 */
export function files(path: string, access: FileAccess = 'read'): FileGrant {
  const grant = parsed('files()', FileGrantSchema.safeParse({ path, access }));
  return brand({ path: grant.path, access: grant.access }, 'files');
}

/**
 * The runtime forms of an `mcp()`, `skill()` and `files()` value, so a branded value can be read
 * again into a plain copy (see `defineAgent`).
 */
export const McpToolSchema = z.object({ connector: ConnectorNameSchema }).strict().readonly();
export const SkillReferenceSchema = z
  .object({ name: SkillNameSchema, revision: SkillRevisionNumberSchema.optional() })
  .strict()
  .readonly();

/** Whether `value` was made by {@link mcp}. */
export function isMcpTool(value: unknown): value is McpTool {
  return hasBrand(value, 'mcp');
}

/** Whether `value` was made by {@link skill}. */
export function isSkillReference(value: unknown): value is SkillReference {
  return hasBrand(value, 'skill');
}

/** Whether `value` was made by {@link files}. */
export function isFileGrant(value: unknown): value is FileGrant {
  return hasBrand(value, 'files');
}

/**
 * A reference to a workspace secret by its name, never its value (contract C10). Made by
 * {@link secret}; a plain `{ secret: NAME }`, as a project file writes it, is accepted wherever a
 * reference belongs too.
 */
export type DefinedSecret = SecretReference & Branded<'secret'>;

/**
 * Names a workspace secret: `A-Z` first, then `A-Z`, `0-9` or `_`, at most 128 characters, and not
 * a name the local runtime reserves (`PORT`, `PATH`, any `AW_` name). Only the name is ever in the
 * code; `aw` resolves the value when the connector is registered.
 *
 * @throws {DefinitionError} when the name is reserved or is not a secret name.
 */
export function secret(name: string): DefinedSecret {
  return brand({ secret: parsed('secret()', SecretNameSchema.safeParse(name)) }, 'secret');
}

/**
 * How an `openapiTool` presents its credential. A bare reference is sent as
 * `Authorization: Bearer`; `{ header, credential }` sends it in the named header.
 */
export type OpenApiToolAuth =
  SecretReference | { readonly header: string; readonly credential: SecretReference };

/** What {@link openapiTool} takes: every key not listed here is refused. */
export interface OpenApiToolInput {
  /** The connector's name in the workspace, 1–200 characters; the agent's tools name it. */
  readonly name: string;
  /**
   * The OpenAPI document: an `https://` URL with no fragment and no credential in it, or a
   * project-relative path such as `openapi/orders.json`. It is read when the project is pushed,
   * never here.
   */
  readonly spec: string;
  /**
   * The `<METHOD> <glob>` or `operationId:<id>` rules that pick the operations. A rule that picks a
   * write (`POST`, `PUT`, `PATCH`, `DELETE`) is admitted; the operation is then implicitly
   * `requireApproval`, and the gateway runs it only for an approved call.
   */
  readonly allow: readonly string[];
  /** The credential, by secret reference. Left out, the API is called with no credential. */
  readonly auth?: OpenApiToolAuth | undefined;
  /** The base URL to call; left out, the document's first server. */
  readonly baseUrl?: string | undefined;
  /**
   * Opt in to the signed identity assertion (ADR-0142 D1): the secret that signs it. The API
   * verifies the `x-aw-identity` header on each call with `verifyIdentity`.
   */
  readonly identity?: SecretReference | undefined;
}

/** What {@link openapiTool} returns: the input as written, frozen and branded. */
export type OpenApiTool = OpenApiToolInput & Branded<'openapi'>;

/** What {@link postgresTool} takes: every key not listed here is refused. */
export interface PostgresToolInput {
  /** The connector's name in the workspace, 1–200 characters; the agent's tools name it. */
  readonly name: string;
  /** The secret holding the connection URL. The URL itself is never in the code. */
  readonly url: SecretReference;
  /** Always `true`: only structured, parameterised reads are supported. */
  readonly readOnly: true;
  /** The `schema.table` names the agent may read, 1–64 of them. */
  readonly tables: readonly string[];
  /** The most rows one read returns, 1–1000; left out, the server's default. */
  readonly maxRows?: number | undefined;
}

/** What {@link postgresTool} returns: the input as written, frozen and branded. */
export type PostgresTool = PostgresToolInput & Branded<'postgres'>;

/**
 * The leaf schemas of a tool connector's create body, read from the contract rather than retyped,
 * so a tool `openapiTool()` or `postgresTool()` accepts is one the server accepts.
 */
const OPENAPI_REQUEST_SHAPE = CreateOpenApiConnectorRequestSchema.unwrap().shape;
const POSTGRES_REQUEST_SHAPE = CreatePostgresConnectorRequestSchema.unwrap().shape;
const [, , HeaderAuthSchema] = OpenApiAuthSchema.options;

/** A spec given as a URL: anything starting `https:`. Everything else is read as a path. */
const SPEC_URL_PREFIX = /^https:/u;
/**
 * The only form a spec URL is written in: `https://` and then a host. `https:x`, `https:/x` and
 * `https:///x` parse too, but to a host the text does not show, so they are refused.
 */
const SPEC_URL_FORM = /^https:\/\/[^/?#]/u;
/** Whitespace, a control character or a backslash, none of which a spec URL may hold. */
const SPEC_URL_REFUSED_CHARACTER = /[\s\p{Cc}\\]/u;
/**
 * The contract's own base URL check (`url-credential`), reused so a spec URL refuses exactly the
 * user names, passwords and credential query parameters (`api_key`, `token`, ...) a base URL does.
 */
const ContractUrlSchema = OPENAPI_REQUEST_SHAPE.baseUrl.unwrap();
/**
 * A project-relative path: an optional leading `./`, then `/`-separated segments. No empty
 * segment, no leading `/`, no backslash, no colon (no drive, scheme or stream name) and no control
 * or format character (no bidirectional override hiding the real name).
 */
const SPEC_PATH_PATTERN = /^(?:\.\/)?(?:[^/\\:\p{Cc}\p{Cf}]+\/)*[^/\\:\p{Cc}\p{Cf}]+$/u;
/** The optional leading `./`, which is not a segment of its own. */
const CURRENT_DIRECTORY_PREFIX = /^\.\//u;
/**
 * A segment that only looks like a name: leading or trailing whitespace, or a trailing dot. Windows
 * drops the trailing dots and spaces, so `.. ` or `x.` name a different file than the text shows.
 */
const SPEC_PATH_AMBIGUOUS_SEGMENT = /^\s|[\s.]$/u;
/** A Windows device name (`CON`, `NUL`, `COM1`, ...), with or without an extension. */
const SPEC_PATH_DEVICE_SEGMENT =
  /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/iu;

const SPEC_NOT_A_SOURCE = 'must be an https URL or a project-relative path';

/** Why `spec`, starting `https:`, is refused, or `null` when it is a plain https URL. */
function specUrlProblem(spec: string): string | null {
  if (spec.length > TOOL_OPERATION_PATH_MAX_LENGTH) return 'must be at most 2048 characters';
  if (SPEC_URL_REFUSED_CHARACTER.test(spec)) {
    return 'must not contain whitespace, a control character or a backslash';
  }
  if (!SPEC_URL_FORM.test(spec) || !URL.canParse(spec)) return SPEC_NOT_A_SOURCE;
  if (spec.includes('#')) return 'must not carry a fragment';
  // What the contract's check still refuses here is a credential: the length, characters, scheme
  // and fragment it also checks were refused above.
  if (!ContractUrlSchema.safeParse(spec).success) {
    return 'must not carry a credential (a user name, password or token parameter); keep it in a secret';
  }
  return null;
}

/** Why `spec` is refused as a project-relative path, or `null` when it is one. */
function specPathProblem(spec: string): string | null {
  if (spec.length > AGENT_DEFINITION_FILE_PATH_MAX_LENGTH) {
    return `must be at most ${String(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH)} characters`;
  }
  if (!SPEC_PATH_PATTERN.test(spec)) return SPEC_NOT_A_SOURCE;
  const segments = spec.replace(CURRENT_DIRECTORY_PREFIX, '').split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return "must not contain a '.' or '..' segment";
  }
  if (segments.some((segment) => SPEC_PATH_AMBIGUOUS_SEGMENT.test(segment))) {
    return 'must not have a segment that starts or ends with whitespace or ends with a dot';
  }
  if (segments.some((segment) => SPEC_PATH_DEVICE_SEGMENT.test(segment))) {
    return 'must not have a segment that is a Windows device name';
  }
  return null;
}

/** One schema, so every refusal of `spec` lands exactly at `spec`. No message echoes it. */
const OpenApiSpecSchema = z.string().superRefine((spec, context) => {
  const problem = SPEC_URL_PREFIX.test(spec) ? specUrlProblem(spec) : specPathProblem(spec);
  if (problem !== null) context.addIssue({ code: 'custom', message: problem });
});

const HeaderAuthReferenceSchema = z
  .object({ header: HeaderAuthSchema.unwrap().shape.header, credential: SecretReferenceSchema })
  .strict()
  .readonly();

/**
 * `auth`: an object with a `header` key is the header form, anything else must be a bare
 * reference. The form is picked by that key rather than by a `z.union`, because a reserved secret
 * name aborts its arm and a union would then report only `Invalid input` at `auth`; this way every
 * refusal lands at its own path (`auth`, `auth.secret`, `auth.header`, `auth.credential.secret`)
 * with its own message.
 */
const OpenApiToolAuthSchema = z.unknown().transform((value, context): OpenApiToolAuth => {
  const isHeaderForm = typeof value === 'object' && value !== null && 'header' in value;
  const result = isHeaderForm
    ? HeaderAuthReferenceSchema.safeParse(value)
    : SecretReferenceSchema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
  return z.NEVER;
});

/** The runtime form of {@link OpenApiToolInput}, built from the contract's own leaf schemas. */
export const OpenApiToolInputSchema = z
  .object({
    name: OPENAPI_REQUEST_SHAPE.name,
    spec: OpenApiSpecSchema,
    allow: OpenApiAllowSchema,
    auth: OpenApiToolAuthSchema.optional(),
    baseUrl: OPENAPI_REQUEST_SHAPE.baseUrl,
    identity: SecretReferenceSchema.optional(),
  })
  .strict()
  .readonly() satisfies z.ZodType<OpenApiToolInput>;

/** The runtime form of {@link PostgresToolInput}, built from the contract's own leaf schemas. */
export const PostgresToolInputSchema = z
  .object({
    name: POSTGRES_REQUEST_SHAPE.name,
    url: SecretReferenceSchema,
    readOnly: POSTGRES_REQUEST_SHAPE.readOnly,
    tables: PostgresTablesSchema,
    maxRows: PostgresMaxRowsSchema.optional(),
  })
  .strict()
  .readonly() satisfies z.ZodType<PostgresToolInput>;

/**
 * Gives the agent an HTTP API as a tool, described by an OpenAPI document (contract C15). It
 * becomes a catalog connector of `name` when the project is pushed, and the agent's version names
 * it in `resources.connectors`. Reads (`GET`, `HEAD`) run freely; every write operation
 * (`POST`, `PUT`, `PATCH`, `DELETE`) is implicitly `requireApproval` and runs only for a call a
 * person approved.
 *
 * ```ts
 * openapiTool({
 *   name: 'orders',
 *   spec: 'openapi/orders.json',
 *   allow: ['GET /orders/*'],
 *   auth: secret('ORDERS_TOKEN'),
 * });
 * ```
 *
 * @throws {DefinitionError} with every reason the input was refused, each at its key: a `spec`
 *   that is neither an https URL nor a project-relative path, a malformed `allow` rule, a
 *   string where a secret reference belongs, or an unknown key.
 */
export function openapiTool(input: OpenApiToolInput): OpenApiTool {
  return brand({ ...parsed('openapiTool()', OpenApiToolInputSchema.safeParse(input)) }, 'openapi');
}

/**
 * Gives the agent read-only access to PostgreSQL tables as a tool (contract C15). The connection
 * URL is a secret reference; the tool becomes a catalog connector of `name` when the project is
 * pushed, and the agent's version names it in `resources.connectors`.
 *
 * @throws {DefinitionError} with every reason the input was refused, each at its key: `readOnly`
 *   not `true`, a table that is not `schema.table`, a `url` that is a string rather than a secret
 *   reference, or an unknown key.
 */
export function postgresTool(input: PostgresToolInput): PostgresTool {
  return brand(
    { ...parsed('postgresTool()', PostgresToolInputSchema.safeParse(input)) },
    'postgres',
  );
}

/** Whether `value` was made by {@link openapiTool}. */
export function isOpenApiTool(value: unknown): value is OpenApiTool {
  return hasBrand(value, 'openapi');
}

/** Whether `value` was made by {@link postgresTool}. */
export function isPostgresTool(value: unknown): value is PostgresTool {
  return hasBrand(value, 'postgres');
}

/** What a code tool's `limits.timeoutMs` is when the declaration names none (issue #693). */
export const CODE_TOOL_DEFAULT_TIMEOUT_MS = 30_000;

/** The longest `limits.timeoutMs` a code tool may ask for: ten minutes. */
export const CODE_TOOL_MAX_TIMEOUT_MS = 600_000;

declare const CODE_TOOL_INPUT: unique symbol;

/** What {@link defineTool} takes: every key not listed here is refused. */
export interface CodeToolInput<I extends z.ZodObject = z.ZodObject> {
  /** The tool's name as the model sees it: 1-41 letters, digits, `_` or `-`. */
  readonly name: string;
  /** What the tool does, for the model, 1-2048 characters. */
  readonly description: string;
  /** The arguments, a Zod object; stored as JSON Schema. */
  readonly input: I;
  /** The result's shape, a Zod schema; stored as JSON Schema. Left out, any result. */
  readonly output?: z.ZodType | undefined;
  /**
   * The run file: a project-relative path to a `.ts` or `.js` file whose default export is a
   * {@link ToolRun}. It is never imported here, nor by the project loader.
   */
  readonly run: string;
  /** `timeoutMs`, 1-600000; left out, 30000. */
  readonly limits?: { readonly timeoutMs?: number | undefined } | undefined;
  /**
   * The workspace secrets the tool reads, as `secret('NAME')`. The tool sandbox's environment holds
   * exactly these, under their names; the tool reads them from `process.env` (ADR-0118 TS4).
   */
  readonly secrets?: readonly SecretReference[] | undefined;
  /**
   * The hosts the tool may reach, each a host name or `*.suffix`. Left out, the tool has no network
   * (ADR-0118 TS5).
   */
  readonly allowedDomains?: readonly string[] | undefined;
}

/**
 * A tool whose function runs in a tool host. Made by {@link defineTool}; the declaration is data
 * (a JSON Schema, a path and limits), the function is in the run file.
 */
export type CodeTool<I extends z.ZodObject = z.ZodObject> = CodeToolDeclaration &
  Branded<'code'> & { readonly [CODE_TOOL_INPUT]?: z.input<I> };

/** The stored form of a code tool. */
export type CodeToolDeclaration = z.infer<typeof CodeToolSchema>;

const JsonSchemaObjectSchema = z.record(z.string(), z.unknown());

const CodeToolRunSchema = z.string().superRefine((run, context) => {
  const problem =
    specPathProblem(run) ?? (/(?<!\.d)\.[jt]s$/u.test(run) ? null : 'must end in .ts or .js');
  if (problem !== null) context.addIssue({ code: 'custom', message: problem });
});

/** The runtime form of a {@link CodeTool}: the declaration as it is stored. */
export const CodeToolSchema = z
  .object({
    name: ToolOperationNameSchema,
    description: z.string().min(1).max(2048),
    inputSchema: JsonSchemaObjectSchema,
    outputSchema: JsonSchemaObjectSchema.optional(),
    run: CodeToolRunSchema,
    limits: z
      .object({ timeoutMs: z.number().int().min(1).max(CODE_TOOL_MAX_TIMEOUT_MS) })
      .strict()
      .readonly(),
    secrets: ToolSecretNamesSchema.optional(),
    allowedDomains: ToolAllowedDomainsSchema.optional(),
  })
  .strict()
  .readonly();

/** The runtime form of {@link CodeToolInput}. */
const CodeToolInputSchema = z
  .object({
    name: z.unknown(),
    description: z.unknown(),
    input: z.instanceof(z.ZodObject, {
      message: 'must be a Zod object, such as z.object({ ... })',
    }),
    output: z.instanceof(z.ZodType, { message: 'must be a Zod schema' }).optional(),
    run: z.unknown(),
    limits: z.object({ timeoutMs: z.unknown().optional() }).strict().optional(),
    secrets: z.array(SecretReferenceSchema).optional(),
    allowedDomains: z.unknown().optional(),
  })
  .strict();

function jsonSchemaOf(
  path: string,
  schema: z.ZodType,
  io: 'input' | 'output',
  problems: { path: string; message: string }[],
) {
  try {
    return z.toJSONSchema(schema, { io });
  } catch {
    problems.push({
      path,
      message: 'cannot be written as JSON Schema (a Date, a function or a transform)',
    });
    return {};
  }
}

/**
 * Declares a tool whose function is in a run file, executed by a tool host rather than by the
 * agent's loader. The declaration is checked now; the run file is not read.
 *
 * ```ts
 * export default defineTool({
 *   name: 'get_order',
 *   description: 'Look up an order by its id',
 *   input: z.object({ id: z.string() }),
 *   run: './tools/get-order.run.ts',
 * });
 * ```
 *
 * @throws {DefinitionError} with every reason the input was refused, each at its key.
 */
export function defineTool<I extends z.ZodObject>(input: CodeToolInput<I>): CodeTool<I> {
  const subject = 'defineTool()';
  const checked = parsed(subject, CodeToolInputSchema.safeParse(input));
  const problems: { path: string; message: string }[] = [];
  const result = CodeToolSchema.safeParse({
    name: checked.name,
    description: checked.description,
    inputSchema: jsonSchemaOf('input', checked.input, 'input', problems),
    outputSchema:
      checked.output === undefined
        ? undefined
        : jsonSchemaOf('output', checked.output, 'output', problems),
    run: checked.run,
    limits: {
      timeoutMs:
        checked.limits?.timeoutMs === undefined
          ? CODE_TOOL_DEFAULT_TIMEOUT_MS
          : checked.limits.timeoutMs,
    },
    ...(checked.secrets === undefined
      ? {}
      : { secrets: checked.secrets.map((reference) => reference.secret) }),
    ...(checked.allowedDomains === undefined ? {} : { allowedDomains: checked.allowedDomains }),
  });
  if (!result.success || problems.length > 0) {
    throw new DefinitionError(subject, [
      ...problems,
      ...(result.success ? [] : issuesFromZod(result.error)),
    ]);
  }
  const declaration = result.data;
  return brand({ ...declaration }, 'code');
}

/** Whether `value` was made by {@link defineTool}. */
export function isCodeTool(value: unknown): value is CodeTool {
  return hasBrand(value, 'code');
}

/**
 * The function in a run file, typed from its declaration:
 * `const run: ToolRun<typeof getOrder> = async ({ id }, { signal }) => ...`. Import the
 * declaration with `import type` so the run file never loads it.
 */
export type ToolRun<T> =
  T extends CodeTool<infer I> ? (input: z.input<I>, context: ToolRunContext) => unknown : never;

/** What the tool host passes a run function besides the arguments. */
export interface ToolRunContext {
  /** Aborted when the call times out or the run ends. */
  readonly signal: AbortSignal;
  /** The run that called the tool. */
  readonly runId: string;
  /** The calling agent's name. */
  readonly agent: string;
}
