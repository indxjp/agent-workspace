import { z } from 'zod';

import { isUuid } from './identifiers.js';
import { NAME_KEY_PATTERN } from './project-file.js';
import { urlCarriesCredential } from './url-credential.js';

/**
 * The tool connectors (ADR-0113 SD1, plan C15): a connector of kind `openapi` (a read-only HTTP
 * API described by an OpenAPI document) or `postgres` (structured, parameterised reads from named
 * tables). Both run in the gateway behind {@link GATEWAY_TOOL_ROUTE} (C16), never in the sandbox.
 * A connector without a kind is an MCP connector (`@indx-workspace/contracts/connectors`).
 *
 * This module imports `zod`, the identifier helpers, the URL credential check and the project key
 * grammar only (none of which import it back), so the connector resource can build on it without a
 * cycle. Every message here is fixed text; none echoes a
 * credential, a URL or the document.
 */
export const TOOL_CONNECTOR_KINDS = ['openapi', 'postgres'] as const;

/** One of {@link TOOL_CONNECTOR_KINDS}. */
export type ToolConnectorKind = (typeof TOOL_CONNECTOR_KINDS)[number];

/**
 * The largest OpenAPI document a create body may carry, in UTF-8 bytes (C15). The server never
 * fetches a document; `aw` sends it as text.
 */
export const OPENAPI_DOCUMENT_MAX_BYTES = 1024 * 1024;

/** The most rules one `allow` list may hold (C15). */
export const OPENAPI_ALLOW_MAX_RULES = 256;

/** The most operations one `openapi` connector may expose as tools. */
export const OPENAPI_OPERATIONS_MAX = 128;

/** The most tables one `postgres` connector may name (C15). */
export const POSTGRES_TABLES_MAX = 64;

/** The highest `maxRows` a `postgres` connector may set (C15). */
export const POSTGRES_MAX_ROWS_LIMIT = 1000;

/** The `maxRows` a `postgres` create body gets when it names none. */
export const POSTGRES_DEFAULT_MAX_ROWS = 100;

/** The longest model-visible tool name an engine accepts (ADR-0113 SD13). */
export const TOOL_NAME_MAX_LENGTH = 64;

/** The longest MCP server key {@link toolServerKey} returns (ADR-0113 SD13). */
export const TOOL_SERVER_KEY_MAX_LENGTH = 16;

/**
 * The longest operation name (ADR-0113 SD13, C17): Claude's worst case is
 * `mcp__<key>__<operation>`, so the cap is 64 − `'mcp__'.length` − 16 − `'__'.length` = 41.
 */
export const TOOL_OPERATION_NAME_MAX_LENGTH = 41;

/** An operation name as the gateway lists it to the model (C17). */
export const TOOL_OPERATION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,41}$/u;

/** The longest operation path template or `allow` path glob, in characters. */
export const TOOL_OPERATION_PATH_MAX_LENGTH = 2048;

/**
 * The local-only MCP connector `aw dev` registers for the tool host that serves `defineTool` code
 * tools (issue #693, ADR-0115). An agent version lists it in `resources.connectors`; a version
 * that does is refused for any environment but `local` (`code_tool_needs_host`).
 */
export const AW_DEV_TOOLS_CONNECTOR = 'aw-dev-tools';

/**
 * The URL `aw push` registers `aw-dev-tools` at on a deployment whose tool sandbox is enabled
 * (ADR-0118 TS3, TS8). It is a reserved name (RFC 6761) that nothing dials: the connector exists
 * so a version can reference it and be promoted, while a run reaches the session's tool sandbox
 * through {@link GATEWAY_TOOL_SANDBOX_ROUTE}, whose origin the server records per run.
 */
export const TOOL_SANDBOX_CONNECTOR_URL = 'https://tool-sandbox.invalid/mcp';

/** The three operations every `postgres` connector exposes (C17). */
export const POSTGRES_TOOL_OPERATION_NAMES = ['list_tables', 'describe', 'select'] as const;

/** The only HTTP methods an `openapi` connector exposes in slice 2 (ADR-0113 SD4). */
export const TOOL_OPERATION_METHODS = ['GET', 'HEAD'] as const;

/** One of {@link TOOL_OPERATION_METHODS}. */
export type ToolOperationMethod = (typeof TOOL_OPERATION_METHODS)[number];

/**
 * Problem codes the tool connector routes add to the connector routes' table, with the status each
 * travels under (ADR-0113 SD4, C15, C17).
 *
 * - `connector_spec_invalid`: the document is empty, too large or unusable, or an `allow` rule
 *   names no operation or admits nothing ({@link selectAllowedOperations}).
 * - `connector_write_unsupported`: an `allow` rule names a method other than `GET`/`HEAD` (in any
 *   case), an `operationId:` rule names such an operation, or a `postgres` body sets `readOnly`
 *   to anything but `true` (SD4).
 * - `connector_tool_name_collision`: two operations of one connector get the same name (C17).
 * - `connector_kind_unsupported`: the body names a kind this server does not create.
 */
export const TOOL_CONNECTOR_PROBLEM_CODES = {
  connector_spec_invalid: 422,
  connector_write_unsupported: 422,
  connector_tool_name_collision: 422,
  connector_kind_unsupported: 400,
} as const;

/** One of the keys of {@link TOOL_CONNECTOR_PROBLEM_CODES}. */
export type ToolConnectorProblemCode = keyof typeof TOOL_CONNECTOR_PROBLEM_CODES;

/**
 * Problem codes the gateway's tool route answers with at run time (C16).
 *
 * The gateway answers a disabled connector, or one from another workspace, with
 * `403 tool_not_in_run` as well, so the route never reveals whether a connector exists. S2-02d may
 * refine this.
 */
export const TOOL_GATEWAY_PROBLEM_CODES = {
  tool_run_not_active: 401,
  tool_not_in_run: 403,
  tool_upstream_failed: 502,
  tool_upstream_timeout: 504,
} as const;

/** One of the keys of {@link TOOL_GATEWAY_PROBLEM_CODES}. */
export type ToolGatewayProblemCode = keyof typeof TOOL_GATEWAY_PROBLEM_CODES;

/**
 * The gateway route an engine reaches a tool connector through (ADR-0113 SD2, C16). Compose hands
 * the engine `{ type: 'http', url: '<gateway>' + gatewayToolPath(id), headers: { authorization:
 * 'Bearer <run token>' } }` and nothing else credential-bearing.
 */
export const GATEWAY_TOOL_ROUTE = { method: 'POST', path: '/v1/tools/:connectorId/mcp' } as const;

/**
 * The path of {@link GATEWAY_TOOL_ROUTE} for one connector. It is only ever given a database id,
 * so a value that is not a UUID is a programming error and throws a `RangeError`.
 */
export function gatewayToolPath(connectorId: string): string {
  if (!isUuid(connectorId)) throw new RangeError('connectorId must be a UUID');
  return `/v1/tools/${connectorId}/mcp`;
}

/**
 * The gateway route an agent reaches its session's tool sandbox through (ADR-0118 TS3). It is keyed
 * by the run token alone: the gateway reads the run's recorded sandbox origin, adds the sandbox's
 * own bearer, and forwards the MCP request. Compose hands the engine `{ type: 'http', url:
 * '<gateway>' + path, headers: { authorization: 'Bearer <run token>' } }` and no sandbox token.
 */
export const GATEWAY_TOOL_SANDBOX_ROUTE = { method: 'POST', path: '/v1/tool-sandbox/mcp' } as const;

const GATEWAY_TOOL_PATH_PATTERN = /^\/v1\/tools\/([^/]+)\/mcp$/u;

/** The connector id in a {@link GATEWAY_TOOL_ROUTE} path, or `null` when the path is not one. */
export function parseGatewayToolPath(pathname: string): string | null {
  const connectorId = GATEWAY_TOOL_PATH_PATTERN.exec(pathname)?.[1];
  return connectorId !== undefined && isUuid(connectorId) ? connectorId : null;
}

const ASCII_UPPER = /^[A-Z]$/u;
const SERVER_KEY_CHARACTER = /^[a-z0-9_]$/u;
const STARTS_WITH_LETTER = /^[a-z]/u;

/**
 * A tool connector's MCP server key in the engine configuration (ADR-0113 SD13, C17), the one
 * definition compose and the tests share. Pure.
 *
 * The connector name, read by code point: ASCII `A`–`Z` lower-cased and every other character
 * outside `[a-z0-9_]` replaced by `_`, with each run of `_` collapsed to one; prefixed with `t_`
 * when it starts with a digit, or `t` when it starts with `_`; cut to
 * {@link TOOL_SERVER_KEY_MAX_LENGTH} with a trailing `_` dropped. An `ordinal` of 2 or more
 * (connectors colliding in one run, in id order) appends `_<ordinal>` within the same 16
 * characters. A key therefore never contains `__` or ends in `_`, so `mcp__<key>__<operation>`
 * splits in one place only. An ordinal that is not a safe integer of at least 1, or whose suffix
 * leaves no room for a key, throws a `RangeError`.
 *
 * The key alone is not unique: `a` with ordinal 2 and a connector named `a_2` both give `a_2`.
 * Compose keys a run's connectors with {@link toolServerKeys}, which checks the final keys.
 */
export function toolServerKey(name: string, ordinal = 1): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new RangeError('ordinal must be a safe integer of at least 1');
  }
  const suffix = ordinal >= 2 ? `_${String(ordinal)}` : '';
  if (suffix.length >= TOOL_SERVER_KEY_MAX_LENGTH) {
    throw new RangeError('ordinal leaves no room for a server key');
  }
  let key = '';
  for (const character of name) {
    if (key.length >= TOOL_SERVER_KEY_MAX_LENGTH) break;
    const lower = ASCII_UPPER.test(character) ? character.toLowerCase() : character;
    const mapped = SERVER_KEY_CHARACTER.test(lower) ? lower : '_';
    if (mapped !== '_' || !key.endsWith('_')) key += mapped;
  }
  let prefixed = key;
  if (!STARTS_WITH_LETTER.test(key)) prefixed = key.startsWith('_') ? `t${key}` : `t_${key}`;
  const cut = prefixed.slice(0, TOOL_SERVER_KEY_MAX_LENGTH - suffix.length);
  return (cut.endsWith('_') ? cut.slice(0, -1) : cut) + suffix;
}

/**
 * The MCP server keys of one run's tool connectors, given their names in id order (ADR-0113 SD13).
 * Each connector takes {@link toolServerKey} with the lowest ordinal whose key no earlier
 * connector holds, so the keys are unique even when a name such as `a_2` spells another's
 * suffixed key: `['a', 'a', 'a_2']` gives `['a', 'a_2', 'a_2_2']`. Pure.
 */
export function toolServerKeys(namesInIdOrder: readonly string[]): readonly string[] {
  const taken = new Set<string>();
  return namesInIdOrder.map((name) => {
    let ordinal = 1;
    let key = toolServerKey(name, ordinal);
    while (taken.has(key)) {
      ordinal += 1;
      key = toolServerKey(name, ordinal);
    }
    taken.add(key);
    return key;
  });
}

/**
 * The longest MCP connector name {@link connectorServerKey} uses as its key: the length of
 * `connector-<uuid>`, so no model-visible tool name is longer than it was (ADR-0113 SD13, #1109).
 */
export const CONNECTOR_SERVER_KEY_MAX_LENGTH = 46;

/** The prefix of the fallback key {@link connectorServerKey} returns, `connector-<id>`. */
const CONNECTOR_SERVER_KEY_PREFIX = 'connector-';

/**
 * MCP server keys a run's other components own, which no connector may take (ADR-0113 SD13): the
 * Claude adapter's skill-script server.
 */
export const RESERVED_MCP_SERVER_KEYS: readonly string[] = ['agent-workspace'];

/**
 * An MCP connector's server key in the engine configuration (ADR-0113 SD13, amended by #1109), the
 * one definition compose and the tests share. Pure.
 *
 * The connector `name` verbatim when it is a project key ({@link NAME_KEY_PATTERN}), at most
 * {@link CONNECTOR_SERVER_KEY_MAX_LENGTH} characters, does not start with `connector-`, is not one
 * of {@link RESERVED_MCP_SERVER_KEYS} and is not in `taken` (the run's tool connector keys, from
 * {@link toolServerKeys}); otherwise `connector-<connectorId>`. A model copies a name it can read;
 * it mistypes a UUID. A slug has no `_`, so `mcp__<key>__<tool>` splits in one place, and names are
 * unique in a workspace, so two MCP connectors never share a slug. The result always satisfies
 * the MCP server-name grammar.
 */
export function connectorServerKey(
  name: string,
  connectorId: string,
  taken: ReadonlySet<string>,
): string {
  const usable =
    NAME_KEY_PATTERN.test(name) &&
    name.length <= CONNECTOR_SERVER_KEY_MAX_LENGTH &&
    !name.startsWith(CONNECTOR_SERVER_KEY_PREFIX) &&
    !RESERVED_MCP_SERVER_KEYS.includes(name) &&
    !taken.has(name);
  return usable ? name : `${CONNECTOR_SERVER_KEY_PREFIX}${connectorId}`;
}

const CONNECTOR_ID_RULE_SERVER = /^mcp__(connector-([0-9a-f-]{36}))__/iu;

/**
 * The server segment `connector-<id>` of a tool rule stored by connector id (`mcp__connector-<id>__
 * <tool>`, ADR-0113 SD13), or `null` for any other rule. Pure.
 */
export function toolRuleConnectorServer(rule: string): string | null {
  const match = CONNECTOR_ID_RULE_SERVER.exec(rule);
  return match?.[1] !== undefined && isUuid(match[2]) ? match[1] : null;
}

/**
 * A tool rule for a person to read: a rule stored as `mcp__connector-<id>__<tool>` followed by the
 * connector's current key, `mcp__connector-<id>__<tool> (<key>)`. `connectorNames` is keyed by
 * `connector-<id>`. Any other rule, and a connector with no entry, is returned unchanged. Display
 * only; never store or send the result back as a rule. Pure.
 */
export function describeToolRule(
  rule: string,
  connectorNames: Readonly<Record<string, string>>,
): string {
  const server = toolRuleConnectorServer(rule);
  const name = server === null ? undefined : connectorNames[server];
  return name === undefined ? rule : `${rule} (${name})`;
}

/** Whitespace or a control character (C0, DEL, C1) anywhere in a value. */
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;
/** A control character (C0, DEL, C1) anywhere in a value. */
const CONTROL_CHARACTER = /\p{Cc}/u;
/** A path or glob starts with `/`. */
const LEADING_SLASH = /^\//u;

/** A custom issue that maps to a tool connector problem code (read by {@link problemCodeOfIssue}). */
function addProblem(
  context: z.RefinementCtx,
  problemCode: ToolConnectorProblemCode,
  message: string,
  path: readonly PropertyKey[] = [],
): void {
  context.addIssue({ code: 'custom', message, path: [...path], params: { problemCode } });
}

/**
 * The tool connector problem code a Zod issue carries in `params.problemCode`, or `null` when it
 * carries none. The server answers an issue with a code under that code's status, and any other
 * issue as `400 invalid_body`.
 */
export function problemCodeOfIssue(issue: z.core.$ZodIssue): ToolConnectorProblemCode | null {
  if (issue.code !== 'custom') return null;
  const code: unknown = issue.params?.['problemCode'];
  return isToolConnectorProblemCode(code) ? code : null;
}

function isToolConnectorProblemCode(value: unknown): value is ToolConnectorProblemCode {
  return typeof value === 'string' && Object.hasOwn(TOOL_CONNECTOR_PROBLEM_CODES, value);
}

/** An operation name as the gateway lists it (C17): {@link TOOL_OPERATION_NAME_PATTERN}. */
export const ToolOperationNameSchema = z
  .string()
  .regex(TOOL_OPERATION_NAME_PATTERN, 'must be 1-41 letters, digits, "_" or "-"');

/**
 * An OpenAPI path template: starts with `/`, at most {@link TOOL_OPERATION_PATH_MAX_LENGTH}
 * characters, no whitespace or control character.
 */
const OperationPathSchema = z
  .string()
  .max(TOOL_OPERATION_PATH_MAX_LENGTH)
  .regex(LEADING_SLASH, 'must start with "/"')
  .refine((path) => !WHITESPACE_OR_CONTROL.test(path), {
    message: 'must not contain whitespace or a control character',
  });

/** One tool an `openapi` connector exposes (C17): its name, its read method and its path template. */
export const ToolOperationSchema = z
  .object({
    name: ToolOperationNameSchema,
    method: z.enum(TOOL_OPERATION_METHODS),
    path: OperationPathSchema,
  })
  .strict()
  .readonly();

/** One of the operations an `openapi` connector exposes. */
export type ToolOperation = z.infer<typeof ToolOperationSchema>;

/** Every other method an OpenAPI document can name: refused as a write in slice 2 (SD4). */
const NON_READ_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
  'CONNECT',
  'QUERY',
]);

const ALLOW_RULE_SHAPE = /^([A-Za-z]+) (.+)$/su;
const OPERATION_ID_PREFIX = /^operationId:/u;
const OPERATION_ID_PREFIX_LENGTH = 'operationId:'.length;
const OPERATION_ID_MAX_LENGTH = 256;
const PATH_SEPARATOR = /\//u;
/** A literal glob segment: printable ASCII without `/`, `?`, `#` or `*`. */
const LITERAL_SEGMENT = /^[\x21-\x22\x24-\x29\x2B-\x2E\x30-\x3E\x40-\x7E]+$/u;

/** One `allow` rule, read. */
type AllowRule =
  | {
      readonly kind: 'path';
      readonly method: ToolOperationMethod;
      readonly glob: readonly string[];
    }
  | { readonly kind: 'operationId'; readonly operationId: string }
  | { readonly kind: 'write' }
  | { readonly kind: 'invalid' };

/** The segments of a path that starts with `/`; `/` alone has none. */
function pathSegments(path: string): readonly string[] {
  return path === '/' ? [] : path.slice(1).split(PATH_SEPARATOR);
}

function isGlobSegments(segments: readonly string[]): boolean {
  return segments.every(
    (segment, index) =>
      segment === '*' ||
      (segment === '**' && index === segments.length - 1) ||
      LITERAL_SEGMENT.test(segment),
  );
}

/**
 * A rule's method: `GET` or `HEAD` exactly, `write` for another HTTP method in any case (so
 * `post /refunds` is the typed write refusal, SD4), or `null` for anything else, including a read
 * method not in upper case.
 */
function readMethod(method: string): ToolOperationMethod | 'write' | null {
  if (method === 'GET' || method === 'HEAD') return method;
  return NON_READ_METHODS.has(method.toUpperCase()) ? 'write' : null;
}

/** Whether an OpenAPI operation's method, in any case, is one slice 2 exposes (SD4). */
function isReadMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD';
}

/** Read one `allow` rule (ADR-0113 SD14); the schema and {@link selectAllowedOperations} share it. */
function readAllowRule(rule: string): AllowRule {
  if (OPERATION_ID_PREFIX.test(rule)) {
    const operationId = rule.slice(OPERATION_ID_PREFIX_LENGTH);
    const valid =
      operationId.length >= 1 &&
      operationId.length <= OPERATION_ID_MAX_LENGTH &&
      !WHITESPACE_OR_CONTROL.test(operationId);
    return valid ? { kind: 'operationId', operationId } : { kind: 'invalid' };
  }
  const match = ALLOW_RULE_SHAPE.exec(rule);
  const methodText = match?.[1];
  const glob = match?.[2];
  if (methodText === undefined || glob === undefined) return { kind: 'invalid' };
  const method = readMethod(methodText);
  if (method === 'write') return { kind: 'write' };
  if (
    method === null ||
    glob.length > TOOL_OPERATION_PATH_MAX_LENGTH ||
    !LEADING_SLASH.test(glob)
  ) {
    return { kind: 'invalid' };
  }
  const segments = pathSegments(glob);
  return isGlobSegments(segments) ? { kind: 'path', method, glob: segments } : { kind: 'invalid' };
}

const WRITE_RULE_MESSAGE = 'only GET and HEAD operations are supported';
const INVALID_RULE_MESSAGE = 'must be "GET <path-glob>", "HEAD <path-glob>" or "operationId:<id>"';

/**
 * One `allow` rule (ADR-0113 SD4, SD14, C15): `GET <glob>`, `HEAD <glob>` or `operationId:<id>`.
 *
 * A glob starts with `/`; each segment is a literal (printable ASCII without `/ ? # *`), `*` (one
 * segment) or `**` (zero or more, last segment only). `GET` and `HEAD` are upper case. Another
 * HTTP method in any case (`POST /refunds`, `post /refunds`) is refused with `params.problemCode`
 * `connector_write_unsupported`. An
 * operation id is 1–256 characters with no whitespace or control character.
 */
export const OpenApiAllowRuleSchema = z.string().superRefine((rule, context) => {
  const read = readAllowRule(rule);
  if (read.kind === 'write') addProblem(context, 'connector_write_unsupported', WRITE_RULE_MESSAGE);
  if (read.kind === 'invalid') context.addIssue({ code: 'custom', message: INVALID_RULE_MESSAGE });
});

/** An `allow` list: 1–{@link OPENAPI_ALLOW_MAX_RULES} rules, no exact duplicates. */
export const OpenApiAllowSchema = z
  .array(OpenApiAllowRuleSchema)
  .min(1)
  .max(OPENAPI_ALLOW_MAX_RULES)
  .superRefine((rules, context) => {
    rules.forEach((rule, index) => {
      if (rules.indexOf(rule) !== index) {
        context.addIssue({ code: 'custom', message: 'duplicate rule', path: [index] });
      }
    });
  })
  .readonly();

/**
 * Header names an `openapi` connector may never put its credential in, compared ignoring case:
 * they frame the request, so a credential there would change what is sent.
 */
export const OPENAPI_AUTH_HEADER_REFUSED_NAMES = [
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
] as const;
Object.freeze(OPENAPI_AUTH_HEADER_REFUSED_NAMES);

const REFUSED_HEADER_SET: ReadonlySet<string> = new Set<string>(OPENAPI_AUTH_HEADER_REFUSED_NAMES);

/** An RFC 9110 field name (a `token`) of at most 128 characters. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;

/**
 * How an `openapi` connector presents its credential: `none`, `bearer` (`Authorization: Bearer`)
 * or `{ header }`, a named header that is an RFC 9110 token and not in
 * {@link OPENAPI_AUTH_HEADER_REFUSED_NAMES}.
 */
export const OpenApiAuthSchema = z.union([
  z.literal('none'),
  z.literal('bearer'),
  z
    .object({
      header: z
        .string()
        .regex(HEADER_NAME_PATTERN, 'must be an HTTP header name of at most 128 characters')
        .refine((header) => !REFUSED_HEADER_SET.has(header.toLowerCase()), {
          message: 'this header cannot carry a credential',
        }),
    })
    .strict()
    .readonly(),
]);

/** How an `openapi` connector presents its credential. */
export type OpenApiAuth = z.infer<typeof OpenApiAuthSchema>;

/** PostgreSQL's system schemas: `information_schema` and every name starting `pg_` (reserved). */
const SYSTEM_SCHEMA = /^(?:pg_|information_schema\.)/iu;

/**
 * A table a `postgres` connector reads: `schema.table`, each part an unquoted-style identifier of
 * at most 63 characters. These are exact catalog names; the gateway quotes them. A table in a
 * system schema (`pg_catalog`, `pg_toast`, any `pg_*`, `information_schema`) is refused: a tool
 * reads the developer's tables, never the catalog.
 */
export const PostgresTableNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_$]{0,62}\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/u,
    'must be a qualified table name "schema.table"',
  )
  .refine((table) => !SYSTEM_SCHEMA.test(table), {
    message: 'must not name a table in a system schema',
  });

/** The tables a `postgres` connector reads: 1–{@link POSTGRES_TABLES_MAX}, unique. */
export const PostgresTablesSchema = z
  .array(PostgresTableNameSchema)
  .min(1)
  .max(POSTGRES_TABLES_MAX)
  .superRefine((tables, context) => {
    tables.forEach((table, index) => {
      if (tables.indexOf(table) !== index) {
        context.addIssue({ code: 'custom', message: 'duplicate table', path: [index] });
      }
    });
  })
  .readonly();

/** The most rows one `select` returns: an integer 1–{@link POSTGRES_MAX_ROWS_LIMIT}. */
export const PostgresMaxRowsSchema = z.number().int().min(1).max(POSTGRES_MAX_ROWS_LIMIT);

/** A bidirectional formatting character (U+202A–U+202E, U+2066–U+2069), which can disguise a name. */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/u;

/**
 * A connector name: 1–200 code points, no line terminator, not blank (as the MCP routes check),
 * and no control character (C0, DEL, C1; PostgreSQL text cannot hold NUL) or bidirectional
 * formatting character.
 */
const ToolConnectorNameSchema = z
  .string()
  .regex(/^.{1,200}$/u, 'must be 1-200 characters on one line')
  .refine((name) => name.trim() !== '', { message: 'must not be blank' })
  .refine((name) => !CONTROL_CHARACTER.test(name) && !BIDI_CONTROL.test(name), {
    message: 'must not contain a control or bidirectional formatting character',
  });

/** The UTF-8 length of `text` in bytes, a lone surrogate counted as U+FFFD (3 bytes). Pure. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * The OpenAPI document as text: not blank and at most {@link OPENAPI_DOCUMENT_MAX_BYTES} in UTF-8.
 * The code-unit length is checked first, so an oversized value is refused without counting it.
 * A refusal carries `params.problemCode` `connector_spec_invalid`.
 */
const OpenApiDocumentSchema = z.string().superRefine((document, context) => {
  if (
    document.length > OPENAPI_DOCUMENT_MAX_BYTES ||
    utf8ByteLength(document) > OPENAPI_DOCUMENT_MAX_BYTES
  ) {
    addProblem(context, 'connector_spec_invalid', 'the document is larger than 1 MiB');
  } else if (document.trim() === '') {
    addProblem(context, 'connector_spec_invalid', 'the document is empty');
  }
});

const FRAGMENT_MARK = /#/u;
const BACKSLASH = /\\/u;

/** The URL in `value`, or `null` when it does not parse. */
function parsedUrl(value: string): URL | null {
  return URL.canParse(value) ? new URL(value) : null;
}

/**
 * The base URL an `openapi` connector calls (ADR-0113 SD15): absolute `http` or `https`, at most
 * 2048 characters, with no fragment, no backslash (which WHATWG reads as `/`, so the stored text
 * and the host called could disagree) and no credential: no user name or password and no
 * credential query parameter such as `api_key` or `token` (`url-credential`). The base URL is
 * stored and echoed in every resource, so a credential belongs in `credential`. Messages never
 * echo the value.
 */
const OpenApiBaseUrlSchema = z
  .string()
  .max(TOOL_OPERATION_PATH_MAX_LENGTH, 'must be at most 2048 characters')
  .superRefine((value, context) => {
    const url = WHITESPACE_OR_CONTROL.test(value) ? null : parsedUrl(value);
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      context.addIssue({ code: 'custom', message: 'must be an absolute http or https URL' });
    } else if (urlCarriesCredential(url)) {
      context.addIssue({
        code: 'custom',
        message: 'must not carry a credential; send it as the write-only credential',
      });
    } else if (FRAGMENT_MARK.test(value)) {
      context.addIssue({ code: 'custom', message: 'must not carry a fragment' });
    } else if (BACKSLASH.test(value)) {
      context.addIssue({ code: 'custom', message: 'must not contain a backslash' });
    }
  });

/**
 * An RFC 9110 field value that survives as sent: visible ASCII, with spaces and tabs only inside
 * (a leading or trailing one would be trimmed). A character above U+00FF cannot be a header byte
 * at all, and Latin-1 bytes are read differently by different servers.
 */
const HEADER_VALUE_PATTERN = /^[\x21-\x7E](?:[\x20-\x7E\t]*[\x21-\x7E])?$/u;

/**
 * A write-only credential sent in a header: an RFC 9110 field value of visible ASCII, with spaces
 * or tabs only inside, so the gateway can always send it and it can never split a header. Sealed
 * as a secret on create and never returned.
 */
const HeaderCredentialSchema = z
  .string()
  .regex(
    HEADER_VALUE_PATTERN,
    'must be visible ASCII, with spaces or tabs only between visible characters',
  );

/**
 * The body of `POST /api/connectors` for an `openapi` connector (ADR-0113 SD1, SD4, SD14, SD15,
 * C15).
 *
 * - `document`: the OpenAPI document as text, up to 1 MiB; the server never fetches one.
 * - `baseUrl`: when absent, `servers[0]` decides it at registration (SD15).
 * - `allow`: the `GET`/`HEAD` rules that pick the operations to expose (SD14).
 * - `auth` (default `none`) and `credential`, write-only: required when `auth` is not `none` and
 *   refused when it is.
 * - `dryRun: true` checks the body and the document without saving.
 *
 * The HTTP body carries the credential value; the define-time form (`openapiTool`) carries a
 * `{ secret: NAME }` reference in its place.
 */
export const CreateOpenApiConnectorRequestSchema = z
  .object({
    kind: z.literal('openapi'),
    name: ToolConnectorNameSchema,
    document: OpenApiDocumentSchema,
    baseUrl: OpenApiBaseUrlSchema.optional(),
    allow: OpenApiAllowSchema,
    auth: OpenApiAuthSchema.default('none'),
    credential: HeaderCredentialSchema.optional(),
    dryRun: z.literal(true).optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.auth !== 'none' && body.credential === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a credential is required when auth is not none',
        path: ['credential'],
      });
    }
    if (body.auth === 'none' && body.credential !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a credential is refused when auth is none',
        path: ['credential'],
      });
    }
  })
  .readonly();

/** The body of `POST /api/connectors` for an `openapi` connector, as a client writes it. */
export type CreateOpenApiConnectorInput = z.input<typeof CreateOpenApiConnectorRequestSchema>;

const POSTGRES_PROTOCOLS: ReadonlySet<string> = new Set(['postgres:', 'postgresql:']);

/**
 * The query parameters a `postgres` connection URL may carry. Every other one is refused, because
 * libpq and `pg` read connection settings from the query: `host` and `hostaddr` replace the host
 * in the authority, `port` its port, `options` sets session settings such as
 * `default_transaction_read_only`, and `sslrootcert`, `passfile` or `service` name files on the
 * gateway's disk.
 */
export const POSTGRES_URL_QUERY_PARAMETERS = [
  'sslmode',
  'connect_timeout',
  'application_name',
] as const;
Object.freeze(POSTGRES_URL_QUERY_PARAMETERS);

const POSTGRES_QUERY_PARAMETER_SET: ReadonlySet<string> = new Set<string>(
  POSTGRES_URL_QUERY_PARAMETERS,
);

/**
 * A host in the authority that is one plain name or address: no `,` (libpq reads a list of
 * hosts) and no `%` (an encoded `/` makes it a Unix socket path).
 */
const SINGLE_HOST = /^[^,%]+$/u;

/**
 * A PostgreSQL connection URL, write-only: `postgres://` or `postgresql://`, at most 4096
 * characters and no control character. Messages never echo it.
 *
 * The host in the URL's authority is the only host the gateway connects to: a list of hosts, a
 * percent-encoded socket path, and every query parameter outside
 * {@link POSTGRES_URL_QUERY_PARAMETERS} (`host`, `hostaddr`, `port`, `options`, file parameters)
 * are refused. The gateway's egress check (S2-02c, S2-02d) must still judge the address the
 * driver resolves that host to, not only the text.
 */
const PostgresCredentialSchema = z
  .string()
  .max(4096, 'must be at most 4096 characters')
  .superRefine((value, context) => {
    const url = CONTROL_CHARACTER.test(value) ? null : parsedUrl(value);
    if (url === null || !POSTGRES_PROTOCOLS.has(url.protocol) || !SINGLE_HOST.test(url.hostname)) {
      context.addIssue({
        code: 'custom',
        message: 'must be a postgres:// or postgresql:// URL with one host',
      });
    } else if ([...url.searchParams.keys()].some((key) => !POSTGRES_QUERY_PARAMETER_SET.has(key))) {
      context.addIssue({
        code: 'custom',
        message: 'may carry only the sslmode, connect_timeout and application_name parameters',
      });
    }
  });

/**
 * `readOnly`, required to be `true` (SD4). `false` is a write request, refused with
 * `params.problemCode` `connector_write_unsupported`; a value that is not a boolean is an ordinary
 * `invalid_body` issue.
 */
const PostgresReadOnlyRequestSchema = z
  .boolean()
  .superRefine((readOnly, context) => {
    if (!readOnly) {
      addProblem(context, 'connector_write_unsupported', 'only reads are supported; set true');
    }
  })
  .pipe(z.literal(true));

/**
 * The body of `POST /api/connectors` for a `postgres` connector (ADR-0113 SD1, SD4, C15).
 *
 * - `credential`: the connection URL, write-only, sealed as a secret and never returned.
 * - `tables`: the 1–64 qualified tables it may read.
 * - `readOnly: true`, required: slice 2 offers only structured, parameterised reads (SD4);
 *   `false` is `422 connector_write_unsupported`.
 * - `maxRows` (default 100, at most 1000) and `dryRun: true`.
 */
export const CreatePostgresConnectorRequestSchema = z
  .object({
    kind: z.literal('postgres'),
    name: ToolConnectorNameSchema,
    credential: PostgresCredentialSchema,
    tables: PostgresTablesSchema,
    readOnly: PostgresReadOnlyRequestSchema,
    maxRows: PostgresMaxRowsSchema.default(POSTGRES_DEFAULT_MAX_ROWS),
    dryRun: z.literal(true).optional(),
  })
  .strict()
  .readonly();

/** The body of `POST /api/connectors` for a `postgres` connector, as a client writes it. */
export type CreatePostgresConnectorInput = z.input<typeof CreatePostgresConnectorRequestSchema>;

/**
 * The body of `POST /api/connectors` for a tool connector, discriminated by `kind` (C15). A body
 * without `kind` is an MCP connector (`CreateConnectorInput`).
 */
export const CreateToolConnectorRequestSchema = z.discriminatedUnion('kind', [
  CreateOpenApiConnectorRequestSchema,
  CreatePostgresConnectorRequestSchema,
]);

/** A tool connector create body, as a client writes it. */
export type CreateToolConnectorInput = z.input<typeof CreateToolConnectorRequestSchema>;

/**
 * What the resource says about the saved document: its SHA-256 digest, its size in bytes and its
 * `info.title` when it has one. Never the document itself.
 */
export const OpenApiSpecSummarySchema = z
  .object({
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u, 'must be sha256:<64 hex digits>'),
    bytes: z.number().int().min(1).max(OPENAPI_DOCUMENT_MAX_BYTES),
    title: z
      .string()
      .regex(/^[^\p{Cc}]{1,200}$/u, 'must be 1-200 characters with no control character')
      .optional(),
  })
  .strict()
  .readonly();

/**
 * The `openapi` half of a connector resource (C15, C17): the document summary, the base URL, how
 * the credential is presented, the `allow` rules and the 1–{@link OPENAPI_OPERATIONS_MAX}
 * operations they admit, unique by name (a duplicate carries `params.problemCode`
 * `connector_tool_name_collision`). Registration refuses an `allow` that admits nothing.
 */
export const OpenApiToolConfigSchema = z
  .object({
    spec: OpenApiSpecSummarySchema,
    baseUrl: OpenApiBaseUrlSchema,
    auth: OpenApiAuthSchema,
    allow: OpenApiAllowSchema,
    operations: z
      .array(ToolOperationSchema)
      .min(1)
      .max(OPENAPI_OPERATIONS_MAX)
      .superRefine((operations, context) => {
        const seen = new Set<string>();
        operations.forEach((operation, index) => {
          if (seen.has(operation.name)) {
            addProblem(context, 'connector_tool_name_collision', 'duplicate operation name', [
              index,
              'name',
            ]);
          }
          seen.add(operation.name);
        });
      })
      .readonly(),
  })
  .strict()
  .readonly();

/** The `openapi` half of a connector resource. */
export type OpenApiToolConfig = z.infer<typeof OpenApiToolConfigSchema>;

/** The `postgres` half of a connector resource (C15): its tables, `readOnly: true` and `maxRows`. */
export const PostgresToolConfigSchema = z
  .object({
    tables: PostgresTablesSchema,
    readOnly: z.literal(true),
    maxRows: PostgresMaxRowsSchema,
  })
  .strict()
  .readonly();

/** The `postgres` half of a connector resource. */
export type PostgresToolConfig = z.infer<typeof PostgresToolConfigSchema>;

/** One operation of an OpenAPI document, as registration hands it to {@link selectAllowedOperations}. */
export interface OpenApiOperationCandidate {
  /** The HTTP method, in any case. */
  readonly method: string;
  /** The path template, e.g. `/orders/{orderId}`. */
  readonly path: string;
  readonly operationId?: string;
}

/** An `allow` rule {@link selectAllowedOperations} refuses, at its path in the create body. */
export interface AllowRuleRefusal {
  readonly path: readonly ['allow', number];
  readonly code: 'connector_spec_invalid' | 'connector_write_unsupported';
  readonly message: string;
}

/** What {@link selectAllowedOperations} decides. */
export interface AllowedOperations<Candidate extends OpenApiOperationCandidate> {
  /** The admitted operations, in document order, each once. */
  readonly admitted: readonly Candidate[];
  readonly refusals: readonly AllowRuleRefusal[];
}

/**
 * Whether a glob's segments match a template's (ADR-0113 SD14). `*` and a literal match one
 * non-empty segment, so `/orders/*` does not admit `/orders/`.
 */
function globMatches(glob: readonly string[], template: readonly string[]): boolean {
  for (const [index, segment] of glob.entries()) {
    if (segment === '**') return true;
    const templateSegment = template[index];
    if (templateSegment === undefined || templateSegment === '') return false;
    if (segment !== '*' && segment !== templateSegment) return false;
  }
  return glob.length === template.length;
}

function ruleRefusal(
  index: number,
  code: AllowRuleRefusal['code'],
  message: string,
): AllowRuleRefusal {
  return { path: ['allow', index], code, message };
}

/**
 * The operations an `allow` list admits (ADR-0113 SD4, SD14), shared by registration (S2-02c) and
 * the tests. Pure.
 *
 * A path rule admits each operation of its method whose template matches segment by segment: a
 * template segment `{x}` is one segment, `*` matches exactly one, a trailing `**` zero or more and
 * a literal itself only. `GET /orders/*` admits `/orders/{orderId}`, not `/orders/{orderId}/items`.
 * A path rule that admits no operation is refused as `connector_spec_invalid`. An `operationId:`
 * rule admits its operation when that is `GET` or `HEAD`; one naming another method is refused as
 * `connector_write_unsupported`, one naming no operation as `connector_spec_invalid`. A rule the
 * schema would refuse is refused here the same way.
 *
 * A candidate whose path is not a valid template (it does not start with `/`, is too long, or
 * holds whitespace or a control character) is never admitted, by any rule.
 */
export function selectAllowedOperations<Candidate extends OpenApiOperationCandidate>(
  allow: readonly string[],
  candidates: readonly Candidate[],
): AllowedOperations<Candidate> {
  const admitted = new Set<Candidate>();
  const refusals: AllowRuleRefusal[] = [];
  const usable = candidates.filter(
    (candidate) => OperationPathSchema.safeParse(candidate.path).success,
  );
  allow.forEach((rule, index) => {
    const read = readAllowRule(rule);
    if (read.kind === 'write') {
      refusals.push(ruleRefusal(index, 'connector_write_unsupported', WRITE_RULE_MESSAGE));
    } else if (read.kind === 'invalid') {
      refusals.push(ruleRefusal(index, 'connector_spec_invalid', INVALID_RULE_MESSAGE));
    } else if (read.kind === 'path') {
      const matched = usable.filter(
        (candidate) =>
          candidate.method.toUpperCase() === read.method &&
          globMatches(read.glob, pathSegments(candidate.path)),
      );
      if (matched.length === 0) {
        refusals.push(ruleRefusal(index, 'connector_spec_invalid', 'admits no operation'));
      }
      for (const candidate of matched) admitted.add(candidate);
    } else {
      const named = usable.filter((candidate) => candidate.operationId === read.operationId);
      if (named.length === 0) {
        refusals.push(ruleRefusal(index, 'connector_spec_invalid', 'names no operation'));
      } else if (named.some((candidate) => !isReadMethod(candidate.method))) {
        refusals.push(ruleRefusal(index, 'connector_write_unsupported', WRITE_RULE_MESSAGE));
      } else {
        for (const candidate of named) admitted.add(candidate);
      }
    }
  });
  return { admitted: candidates.filter((candidate) => admitted.has(candidate)), refusals };
}
