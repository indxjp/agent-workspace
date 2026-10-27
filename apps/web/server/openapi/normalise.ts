/**
 * Turns an OpenAPI document into the operations an `openapi` connector exposes (ADR-0113 SD4,
 * SD14, SD15, C15, C17). Pure: no I/O, no fetch, no clock. The egress pre-check of the base URL is
 * the caller's (`../connectors/tools.ts`).
 *
 * The stages run in order and the first failing stage answers, with every problem it found:
 * parse (JSON or YAML) → `openapi` version → internal `$ref` resolution → operation count →
 * `allow` filtering (`selectAllowedOperations`), the parameter-style subset and the JSON-only
 * request bodies of writes (#1304) → C17 names →
 * SD15 base URL → the contracts schema as a backstop.
 */
import { createHash } from 'node:crypto';

import {
  OPENAPI_OPERATIONS_MAX,
  OpenApiToolConfigSchema,
  problemCodeOfIssue,
  selectAllowedOperations,
  TOOL_OPERATION_NAME_MAX_LENGTH,
  TOOL_WRITE_METHODS,
  type OpenApiAuth,
  type OpenApiToolConfig,
  type ToolConnectorProblemCode,
} from '@indx-workspace/contracts/tool-connectors';
import { parse as parseYaml } from 'yaml';

/** One parameter of an exposed operation, kept for the gateway's executor (S2-02d). */
export interface OperationParameter {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly style?: string;
  readonly schema?: unknown;
}

export interface NormaliseInput {
  readonly document: string;
  readonly baseUrl?: string | undefined;
  readonly allow: readonly string[];
  readonly auth: OpenApiAuth;
}

export type NormaliseResult =
  | {
      readonly ok: true;
      readonly openapi: OpenApiToolConfig;
      /** Each exposed operation's parameters, by operation name. */
      readonly parameters: Readonly<Record<string, readonly OperationParameter[]>>;
      /** `true` when the base URL came from `servers[0]` rather than the body (SD15). */
      readonly baseUrlFromServers: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ToolConnectorProblemCode;
      readonly details: readonly string[];
    };

const OPENAPI_VERSION = /^3\.[01]\.\d+$/u;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const SUPPORTED_STYLES: ReadonlySet<string> = new Set(['simple', 'form']);
const REF_DEPTH_MAX = 32;
const NODE_BUDGET = 100_000;
/** Nesting `walk` follows before refusing, far below the stack a recursive walk can use. */
const NESTING_MAX = 512;
const NAME_RUN = /[^A-Za-z0-9_-]+/gu;
const EDGE_UNDERSCORES = /^_+|_+$/gu;
const TITLE_PATTERN = /^[^\p{Cc}]{1,200}$/u;
const SERVER_VARIABLE = /\{([^{}]*)\}/gu;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refused(
  details: readonly string[],
  code: ToolConnectorProblemCode = 'connector_spec_invalid',
): NormaliseResult {
  return { ok: false, code, details };
}

class BudgetExceeded extends Error {}
class NestingExceeded extends Error {}

/** The value a `#/…` JSON pointer names in `root`, or `undefined`. */
function pointerTarget(root: unknown, ref: string): unknown {
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let token: string;
    try {
      token = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    token = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node)) node = node[Number(token)];
    else if (isObject(node) && Object.hasOwn(node, token)) node = node[token];
    else return undefined;
  }
  return node;
}

/**
 * The document with every internal `$ref` replaced by its target. An external ref, or one naming
 * nothing, is a problem naming the ref. Throws `BudgetExceeded` or `NestingExceeded` instead of
 * growing without bound, so a hostile document cannot overflow the stack (a `RangeError`, a 500).
 */
function resolveRefs(root: unknown): { value: unknown; problems: string[] } {
  const problems: string[] = [];
  let nodes = 0;
  const walk = (node: unknown, stack: readonly string[], depth: number): unknown => {
    nodes += 1;
    if (nodes > NODE_BUDGET) throw new BudgetExceeded();
    if (depth > NESTING_MAX) throw new NestingExceeded();
    if (Array.isArray(node)) return node.map((item) => walk(item, stack, depth + 1));
    if (!isObject(node)) return node;
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      if (!ref.startsWith('#/')) {
        problems.push(
          `$ref ${JSON.stringify(ref)}: only references within the document are supported`,
        );
        return {};
      }
      // ponytail: cycles cut to {} at depth 32; the gateway sees an open schema there, upgrade = typed recursive schemas if a tool needs them
      if (stack.includes(ref) || stack.length >= REF_DEPTH_MAX) return {};
      const target = pointerTarget(root, ref);
      if (target === undefined) {
        problems.push(`$ref ${JSON.stringify(ref)}: names nothing in the document`);
        return {};
      }
      return walk(target, [...stack, ref], depth + 1);
    }
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, walk(value, stack, depth + 1)]),
    );
  };
  return { value: walk(root, [], 0), problems };
}

/** The one argument an operation's JSON request body is exposed as (ADR-0113 SD4, #1304). */
const BODY_PARAMETER = 'body';

/** A write operation's request body: none, `application/json`, or some other media type only. */
type RequestBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'json'; readonly required: boolean; readonly schema: unknown }
  | { readonly kind: 'other' };

interface Candidate {
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly parameters: readonly OperationParameter[];
  readonly requestBody: RequestBody;
}

function requestBodyOf(operation: Json): RequestBody {
  const body = operation['requestBody'];
  if (!isObject(body)) return { kind: 'none' };
  const content = isObject(body['content']) ? body['content'] : {};
  const json = content['application/json'];
  if (!isObject(json)) return { kind: 'other' };
  return { kind: 'json', required: body['required'] === true, schema: json['schema'] ?? {} };
}

function parametersOf(list: unknown): OperationParameter[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): OperationParameter[] => {
    if (!isObject(entry) || typeof entry['name'] !== 'string' || typeof entry['in'] !== 'string') {
      return [];
    }
    return [
      {
        name: entry['name'],
        in: entry['in'],
        required:
          typeof entry['required'] === 'boolean' ? entry['required'] : entry['in'] === 'path',
        ...(typeof entry['style'] === 'string' ? { style: entry['style'] } : {}),
        ...(entry['schema'] === undefined ? {} : { schema: entry['schema'] }),
      },
    ];
  });
}

/** Every operation in `paths`, in document order; an operation's parameters override its path's. */
function candidatesOf(paths: Json): Candidate[] {
  return Object.entries(paths).flatMap(([path, item]): Candidate[] => {
    if (!isObject(item)) return [];
    const shared = parametersOf(item['parameters']);
    return METHODS.flatMap((method): Candidate[] => {
      const operation = item[method];
      if (!isObject(operation)) return [];
      const own = parametersOf(operation['parameters']);
      const parameters = [
        ...shared.filter((p) => !own.some((o) => o.name === p.name && o.in === p.in)),
        ...own,
      ];
      const operationId = operation['operationId'];
      return [
        {
          method: method.toUpperCase(),
          path,
          ...(typeof operationId === 'string' ? { operationId } : {}),
          parameters,
          requestBody: requestBodyOf(operation),
        },
      ];
    });
  });
}

function isWrite(candidate: Candidate): boolean {
  return TOOL_WRITE_METHODS.some((method) => method === candidate.method);
}

/** Why an admitted write's request body cannot be exposed: JSON only, and `body` must be free. */
function bodyProblemsOf(candidate: Candidate): string[] {
  if (!isWrite(candidate)) return [];
  const where = `${candidate.method} ${candidate.path}`;
  if (candidate.requestBody.kind === 'other') {
    return [`${where}: only application/json request bodies are supported`];
  }
  if (
    candidate.requestBody.kind === 'json' &&
    candidate.parameters.some((p) => p.name === BODY_PARAMETER)
  ) {
    return [`${where}: a parameter named "body" collides with the request body argument`];
  }
  return [];
}

/** The operation's parameters, with a write's JSON request body appended as the `body` argument. */
function parametersWithBody(candidate: Candidate): readonly OperationParameter[] {
  const { requestBody } = candidate;
  if (!isWrite(candidate) || requestBody.kind !== 'json') return candidate.parameters;
  return [
    ...candidate.parameters,
    {
      name: BODY_PARAMETER,
      in: 'body',
      required: requestBody.required,
      schema: requestBody.schema,
    },
  ];
}

function sanitise(text: string): string {
  return text.replace(NAME_RUN, '_');
}

/** C17: the sanitised `operationId` when it fits, else `<method>_<path>` sanitised and cut to 41. */
export function operationName(candidate: {
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
}): string {
  const fromId = candidate.operationId === undefined ? '' : sanitise(candidate.operationId);
  if (fromId.length >= 1 && fromId.length <= TOOL_OPERATION_NAME_MAX_LENGTH) return fromId;
  const path = sanitise(candidate.path).replace(EDGE_UNDERSCORES, '');
  return `${candidate.method.toLowerCase()}_${path}`
    .slice(0, TOOL_OPERATION_NAME_MAX_LENGTH)
    .replace(EDGE_UNDERSCORES, '');
}

/** SD15: `servers[0].url` with each variable's default substituted, absolute http(s) only. */
function baseUrlFromServers(document: Json): { url: string } | { problem: string } {
  const servers = document['servers'];
  const first: unknown = Array.isArray(servers) ? servers[0] : undefined;
  if (!isObject(first) || typeof first['url'] !== 'string') {
    return { problem: 'servers: the document names no server and the body sends no baseUrl' };
  }
  const variables = isObject(first['variables']) ? first['variables'] : {};
  const missing: string[] = [];
  const url = first['url'].replace(SERVER_VARIABLE, (_, name: string) => {
    const variable = variables[name];
    if (isObject(variable) && typeof variable['default'] === 'string') return variable['default'];
    missing.push(name);
    return '';
  });
  if (missing.length > 0) {
    return { problem: `servers: variable ${JSON.stringify(missing[0])} has no default` };
  }
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { problem: 'servers: servers[0].url is not an absolute http or https URL' };
  }
  return { url };
}

function specSummary(text: string, document: Json): OpenApiToolConfig['spec'] {
  const info = document['info'];
  const title = isObject(info) ? info['title'] : undefined;
  return {
    digest: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    bytes: Buffer.byteLength(text, 'utf8'),
    ...(typeof title === 'string' && TITLE_PATTERN.test(title) ? { title } : {}),
  };
}

/** Normalise one `openapi` create body's document. See this file's header for the stages. */
export function normaliseOpenApi(input: NormaliseInput): NormaliseResult {
  let parsed: unknown;
  try {
    // `uniqueKeys` stays at its default (a duplicate key is an error); `logLevel: 'error'` keeps a
    // caller's document out of the server log as a warning.
    parsed = parseYaml(input.document, { maxAliasCount: 100, logLevel: 'error' });
  } catch {
    return refused(['document: is not a valid JSON or YAML document (duplicate keys included)']);
  }
  if (!isObject(parsed)) return refused(['document: must be an object']);
  const version = parsed['openapi'];
  if (typeof version !== 'string' || !OPENAPI_VERSION.test(version)) {
    return refused(['document.openapi: must be an OpenAPI 3.0.x or 3.1.x version']);
  }

  let resolved: { value: unknown; problems: string[] };
  try {
    resolved = resolveRefs(parsed);
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      return refused([`document: expands beyond ${String(NODE_BUDGET)} nodes`]);
    }
    if (error instanceof NestingExceeded) {
      return refused([`document: nests deeper than ${String(NESTING_MAX)} levels`]);
    }
    throw error;
  }
  if (resolved.problems.length > 0) return refused(resolved.problems);
  const document = resolved.value as Json;
  const paths = document['paths'];
  if (!isObject(paths)) return refused(['document.paths: must be an object']);

  const candidates = candidatesOf(paths);
  if (candidates.length > OPENAPI_OPERATIONS_MAX) {
    return refused([
      `document: has ${String(candidates.length)} operations; at most ${String(OPENAPI_OPERATIONS_MAX)} are supported`,
    ]);
  }

  const selected = selectAllowedOperations(input.allow, candidates);
  if (selected.refusals.length > 0) {
    return refused(selected.refusals.map((r) => `${r.path.join('.')}: ${r.message}`));
  }
  const styleProblems = selected.admitted.flatMap((candidate) =>
    candidate.parameters
      .filter((p) => p.style !== undefined && !SUPPORTED_STYLES.has(p.style))
      .map(
        (p) =>
          `${candidate.method} ${candidate.path}: parameter ${JSON.stringify(p.name)} uses style ${JSON.stringify(p.style)}; only simple and form are supported`,
      ),
  );
  if (styleProblems.length > 0) return refused(styleProblems);
  const bodyProblems = selected.admitted.flatMap(bodyProblemsOf);
  if (bodyProblems.length > 0) return refused(bodyProblems);

  const named = new Map<string, Candidate>();
  const collisions: string[] = [];
  for (const candidate of selected.admitted) {
    const name = operationName(candidate);
    const earlier = named.get(name);
    if (earlier === undefined) named.set(name, candidate);
    else {
      collisions.push(
        `operations: ${JSON.stringify(name)} names both ${earlier.method} ${earlier.path} and ${candidate.method} ${candidate.path}`,
      );
    }
  }
  if (collisions.length > 0) return refused(collisions, 'connector_tool_name_collision');

  let baseUrl = input.baseUrl;
  if (baseUrl === undefined) {
    const derived = baseUrlFromServers(document);
    if ('problem' in derived) return refused([derived.problem]);
    baseUrl = derived.url;
  }
  const fromServers = input.baseUrl === undefined;

  const parameters = Object.fromEntries(
    [...named].map(([name, candidate]) => [name, parametersWithBody(candidate)]),
  );
  let hasNul = false;
  JSON.stringify(parameters, (key, value: unknown) => {
    if (key.includes('\0') || (typeof value === 'string' && value.includes('\0'))) hasNul = true;
    return value;
  });
  if (hasNul) {
    return refused(['document: a parameter holds U+0000, which cannot be stored']);
  }
  const config = OpenApiToolConfigSchema.safeParse({
    spec: specSummary(input.document, parsed),
    baseUrl,
    auth: input.auth,
    allow: input.allow,
    operations: [...named].map(([name, candidate]) => ({
      name,
      method: candidate.method,
      path: candidate.path,
    })),
  });
  if (!config.success) {
    const issues = config.error.issues;
    const code = issues.map(problemCodeOfIssue).find((c) => c !== null) ?? 'connector_spec_invalid';
    return refused(
      issues.map((issue) => {
        const path = issue.path.map(String);
        if (fromServers && path[0] === 'baseUrl') path[0] = 'servers';
        return `${path.join('.')}: ${issue.message}`;
      }),
      code,
    );
  }
  return { ok: true, openapi: config.data, parameters, baseUrlFromServers: fromServers };
}
