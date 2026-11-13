#!/usr/bin/env node
/**
 * Generates `docs/sdk/site/openapi.json` — the OpenAPI 3.1 document of the public `/api/**`
 * surface — from `@indx-workspace/contracts` (SDK unit 13, issue #245, P-7, ADR-0080).
 *
 * The route catalogue (`packages/contracts/src/routes.ts`) names, for every public route, the
 * Zod schemas its request and responses are parsed with; each schema is converted with Zod's own
 * `toJSONSchema` (draft 2020-12, the dialect OpenAPI 3.1 uses), so the document and the SDK read
 * one source. The document is generated, never the source of truth (03 §3.7).
 *
 * `--write` rewrites the committed document; `--check` renders it in memory and fails when the
 * committed file differs — the same rule ADR-0054 applies to the reference pages. Output is
 * deterministic: every object's keys are sorted, two-space indentation, LF, one trailing newline.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

/** Repo-relative path of the emitted document. */
export const OPENAPI_OUTPUT = 'docs/sdk/site/openapi.json';

/**
 * Node 24 runs the contracts' TypeScript source directly (type stripping), so the generator reads
 * the source through the package's public entry points and needs no build first. Two mappings make
 * that work: `@indx-workspace/contracts/*` is resolved under the `types` export condition (which
 * names `src/*.ts`, not `dist/*.js`), and inside that source a sibling import `./x.js` — the
 * specifier `tsc` emits — is mapped to the `./x.ts` next to it.
 */
let hooksRegistered = false;

function resolveContractsFromSource() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === '@indx-workspace/contracts' ||
        specifier.startsWith('@indx-workspace/contracts/')
      ) {
        return nextResolve(specifier, { ...context, conditions: ['types', ...context.conditions] });
      }
      const parent = context.parentURL;
      if (
        parent !== undefined &&
        parent.endsWith('.ts') &&
        specifier.startsWith('.') &&
        specifier.endsWith('.js')
      ) {
        const candidate = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, parent);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * The route catalogue and the contracts-version surface of ADR-0078 (header names, problem codes),
 * both read from the contracts source so the document cannot drift from them.
 */
async function loadContracts() {
  resolveContractsFromSource();
  /** @type {typeof import('@indx-workspace/contracts/routes')} */
  const routes = await import('@indx-workspace/contracts/routes');
  /** @type {typeof import('@indx-workspace/contracts')} */
  const root = await import('@indx-workspace/contracts');
  return {
    API_ROUTES: routes.API_ROUTES,
    API_SCHEMAS: routes.API_SCHEMAS,
    CONTRACTS_VERSION_HEADER: root.CONTRACTS_VERSION_HEADER,
    CONTRACTS_MINIMUM_VERSION_HEADER: root.CONTRACTS_MINIMUM_VERSION_HEADER,
    CONTRACTS_VERSION_PROBLEM_CODES: root.CONTRACTS_VERSION_PROBLEM_CODES,
  };
}

/** The OpenAPI `security` of a route whose credential is not the default (`ApiRoute.security`). */
const ROUTE_SECURITY = {
  none: [],
  'session-cookie': [{ sessionCookie: [] }],
  'invitation-identity': [{ invitationCookie: [] }],
  'user-token': [{ bearerAuth: [] }],
  'endpoint-credential': [{ bearerAuth: [] }],
};

/**
 * A deep copy with every object's keys sorted; arrays keep their order.
 * @template T
 * @param {T} value
 * @returns {T} The same shape: only the key order changes.
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return /** @type {T} */ (value.map((item) => sortKeysDeep(item)));
  if (value !== null && typeof value === 'object') {
    return /** @type {T} */ (
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, item]) => [key, sortKeysDeep(item)]),
      )
    );
  }
  return value;
}

/**
 * @typedef {import('@indx-workspace/contracts/routes').ApiSchemaName} ApiSchemaName
 * @typedef {import('@indx-workspace/contracts/routes').ApiBody} ApiBody
 * @typedef {'input' | 'output'} Direction
 */

/**
 * `Schema`-suffixed export name → component name: `MeResponseSchema` → `MeResponse`.
 * @param {string} schemaName
 */
function componentName(schemaName) {
  return schemaName.replace(/Schema$/u, '');
}

const ref = (/** @type {string} */ name) => ({ $ref: `#/components/schemas/${name}` });

/**
 * Replace every local JSON-pointer `$ref` in `node` through `rewrite`. Zod emits `#/$defs/…` (and
 * `#` for a self-reference) relative to the schema it converted; inside an OpenAPI document those
 * pointers would resolve against the document root, so they are rewritten to components.
 * @param {unknown} node @param {(pointer: string) => string} rewrite
 * @returns {unknown}
 */
function rewriteRefs(node, rewrite) {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, rewrite));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) =>
        key === '$ref' && typeof value === 'string'
          ? [key, rewrite(value)]
          : [key, rewriteRefs(value, rewrite)],
      ),
    );
  }
  return node;
}

/**
 * Convert one schema into `components.schemas` entries: the schema itself under `name`, and each
 * of its `$defs` hoisted as `name_def`.
 * @param {(typeof import('@indx-workspace/contracts/routes').API_SCHEMAS)[ApiSchemaName]} schema
 * @param {string} name @param {Direction} io
 * @returns {Record<string, unknown>}
 */
function toComponents(schema, name, io) {
  const converted = schema.toJSONSchema({
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  });
  const { $defs = {}, ...root } = converted;
  delete root.$schema;
  const rewrite = (/** @type {string} */ pointer) => {
    if (pointer === '#') return `#/components/schemas/${name}`;
    const match = /^#\/\$defs\/(.+)$/u.exec(pointer);
    if (match === null) throw new Error(`${name}: unexpected $ref ${pointer}`);
    return `#/components/schemas/${name}_${match[1]}`;
  };
  const out = { [name]: rewriteRefs(root, rewrite) };
  for (const [defName, def] of Object.entries($defs)) {
    out[`${name}_${defName}`] = rewriteRefs(def, rewrite);
  }
  return out;
}

const UNDESCRIBED_NOTE =
  'Not yet described by a contract schema; the route catalogue lists it as `json-undescribed` ' +
  '(packages/contracts/src/routes.ts).';

/**
 * Build the document.
 * @param {string} repoRoot
 * @returns {Promise<Record<string, unknown>>}
 */
export async function buildOpenApiDocument(repoRoot) {
  const {
    API_ROUTES,
    API_SCHEMAS,
    CONTRACTS_VERSION_HEADER,
    CONTRACTS_MINIMUM_VERSION_HEADER,
    CONTRACTS_VERSION_PROBLEM_CODES,
  } = await loadContracts();
  const UNSUPPORTED = 'contracts_version_unsupported';
  const MALFORMED = 'contracts_version_malformed';
  const unsupportedStatus = String(CONTRACTS_VERSION_PROBLEM_CODES[UNSUPPORTED]);
  const malformedStatus = String(CONTRACTS_VERSION_PROBLEM_CODES[MALFORMED]);
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/contracts/package.json'), 'utf8'),
  );

  /** @type {Record<string, unknown>} */
  const schemas = {};
  /**
   * Component name of `schemaName` in the given direction; converts it on first use.
   * @param {ApiSchemaName} schemaName @param {Direction} io
   */
  const component = (schemaName, io) => {
    const schema = API_SCHEMAS[schemaName];
    if (schema === undefined) throw new Error(`unknown schema ${schemaName}`);
    const outputName = componentName(schemaName);
    if (!(outputName in schemas))
      Object.assign(schemas, toComponents(schema, outputName, 'output'));
    if (io === 'output') return outputName;
    const inputName = `${outputName}Input`;
    if (inputName in schemas) return inputName;
    const input = toComponents(schema, inputName, 'input');
    const asOutput = toComponents(schema, outputName, 'output');
    // One component when both directions agree, which is the common case.
    if (JSON.stringify(input[inputName]) === JSON.stringify(asOutput[outputName]))
      return outputName;
    Object.assign(schemas, input);
    return inputName;
  };

  /** @param {ApiBody} body @param {Direction} io */
  const content = (body, io) => {
    switch (body.kind) {
      case 'json': {
        const names = body.schemas.map((name) => component(name, io));
        const [only, ...more] = names;
        const schema =
          only !== undefined && more.length === 0
            ? ref(only)
            : { oneOf: names.map((name) => ref(name)) };
        return { 'application/json': { schema } };
      }
      case 'json-undescribed':
        return { 'application/json': { schema: { description: UNDESCRIBED_NOTE } } };
      case 'binary':
        return {
          'application/octet-stream': {
            schema: { contentMediaType: 'application/octet-stream', type: 'string' },
          },
        };
      case 'event-stream':
        return {
          'text/event-stream': {
            schema: {
              description:
                'A stream of Server-Sent Events. Each frame names its kind in `event:`; its `data:` ' +
                'is one JSON value matching one of `x-agent-workspace-frames`. Durable frames carry ' +
                '`id:`; resume by sending it back as `Last-Event-ID`.',
              type: 'string',
            },
            'x-agent-workspace-frames': body.frames.map((name) => ref(component(name, 'output'))),
          },
        };
      case 'multipart': {
        /** @type {Record<string, unknown>} */
        const properties = {};
        /** @type {Record<string, unknown>} */
        const encoding = {};
        for (const part of body.parts) {
          const value =
            part.type === 'text'
              ? { type: 'string' }
              : { contentMediaType: 'application/octet-stream', type: 'string' };
          properties[part.name] =
            part.repeated === true
              ? { description: part.description, items: value, minItems: 1, type: 'array' }
              : { ...value, description: part.description };
          encoding[part.name] = {
            contentType: part.type === 'text' ? 'text/plain' : 'application/octet-stream',
          };
        }
        return {
          'multipart/form-data': {
            encoding,
            schema: {
              properties,
              required: body.parts.map((part) => part.name),
              type: 'object',
            },
          },
        };
      }
      default:
        throw new Error(`unexpected body kind ${body.kind}`);
    }
  };

  const rangeHeaders = {
    [CONTRACTS_VERSION_HEADER]: { $ref: '#/components/headers/ContractsVersion' },
    [CONTRACTS_MINIMUM_VERSION_HEADER]: { $ref: '#/components/headers/ContractsMinimumVersion' },
  };

  /** @type {Record<string, Record<string, unknown>>} */
  const paths = {};
  const operationIds = new Set();
  for (const route of API_ROUTES) {
    if (operationIds.has(route.operationId)) {
      throw new Error(`operationId ${route.operationId} is used twice`);
    }
    operationIds.add(route.operationId);
    const openApiPath = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, '{$1}');
    const pathParameters = [...route.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/gu)].map((match) => ({
      in: 'path',
      name: match[1],
      required: true,
      schema: { type: 'string' },
    }));
    /** @type {Record<string, unknown>} */
    const responses = {
      [malformedStatus]: { $ref: '#/components/responses/BadRequest' },
      [unsupportedStatus]: { $ref: '#/components/responses/ContractsVersionUnsupported' },
      default: { $ref: '#/components/responses/Problem' },
    };
    for (const success of route.success) {
      responses[String(success.status)] = {
        description: success.status === 204 ? 'No content.' : 'Success.',
        headers: rangeHeaders,
        ...(success.body.kind === 'none' ? {} : { content: content(success.body, 'output') }),
      };
    }
    /** @type {Record<string, unknown>} */
    const operation = {
      operationId: route.operationId,
      parameters: [
        ...pathParameters,
        ...(route.headers ?? []).map((header) => ({
          in: 'header',
          name: header.name,
          required: header.required,
          description: header.description,
          schema: { type: 'string' },
        })),
        { $ref: '#/components/parameters/ContractsVersion' },
      ],
      responses,
      summary: route.summary,
      tags: [route.tag],
      'x-agent-workspace-feature': route.feature,
    };
    if (route.request !== undefined && route.request.kind !== 'none') {
      /** @type {Record<string, Record<string, unknown>>} */
      const accepted = { ...content(route.request, 'input') };
      for (const older of route.deprecatedRequests ?? []) {
        for (const [mediaType, media] of Object.entries(content(older, 'input'))) {
          // OpenAPI has no per-media-type flag; the schema's own `deprecated` carries it.
          const schema = /** @type {Record<string, unknown>} */ (media['schema']);
          accepted[mediaType] = { ...media, schema: { ...schema, deprecated: true } };
        }
      }
      operation['requestBody'] = { content: accepted, required: true };
    }
    if (route.deprecated === true) operation['deprecated'] = true;
    if (route.security !== undefined) {
      const security = ROUTE_SECURITY[route.security];
      if (security === undefined) throw new Error(`unexpected security ${route.security}`);
      operation['security'] = security;
    }
    const item = (paths[openApiPath] ??= {});
    const method = route.method.toLowerCase();
    if (method in item) throw new Error(`${route.method} ${route.path} is catalogued twice`);
    item[method] = operation;
  }

  const problemSchema = component('ApiProblemSchema', 'output');
  const tags = [...new Set(API_ROUTES.map((route) => route.tag))].sort().map((name) => ({ name }));

  return sortKeysDeep({
    openapi: '3.1.0',
    info: {
      title: 'Agent Workspace API',
      version: manifest.version,
      description:
        'The public `/api/**` surface of the Agent Workspace control plane, generated from ' +
        '`@indx-workspace/contracts` by `scripts/docs/generate-openapi.mjs`. Never edit it by ' +
        'hand: the Zod schemas are the source of truth. Every failure is the standard envelope ' +
        '`{ error: { code, message, details?, detail? } }`.',
      license: { name: manifest.license, identifier: manifest.license },
    },
    servers: [{ url: 'http://localhost:3000', description: 'A control plane on this machine' }],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    tags,
    paths,
    components: {
      schemas,
      parameters: {
        ContractsVersion: {
          in: 'header',
          name: CONTRACTS_VERSION_HEADER,
          required: false,
          description:
            'The contracts version (`MAJOR.MINOR.PATCH`) the client was built against. A version ' +
            `outside the served range is refused with \`${unsupportedStatus} ${UNSUPPORTED}\`; one ` +
            `that is not a version with \`${malformedStatus} ${MALFORMED}\`. A request without it ` +
            'is accepted and served at the current version (ADR-0078).',
          schema: {
            pattern: '^(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})$',
            type: 'string',
          },
        },
      },
      headers: {
        ContractsVersion: {
          description: 'The newest contracts version the server serves.',
          schema: { type: 'string' },
        },
        ContractsMinimumVersion: {
          description: 'The oldest contracts version the server still serves.',
          schema: { type: 'string' },
        },
      },
      responses: {
        Problem: {
          description: 'The standard error envelope. Branch on `error.code`, never on `message`.',
          headers: rangeHeaders,
          content: { 'application/json': { schema: ref(problemSchema) } },
        },
        BadRequest: {
          description:
            `\`${MALFORMED}\` when the \`${CONTRACTS_VERSION_HEADER}\` header is not a version, ` +
            'refused before authentication; otherwise the route’s own validation failure.',
          headers: rangeHeaders,
          content: { 'application/json': { schema: ref(problemSchema) } },
        },
        ContractsVersionUnsupported: {
          description:
            `\`${UNSUPPORTED}\`: the client’s contracts version is outside the served range, ` +
            'refused before authentication; the range headers say which side must upgrade.',
          headers: {
            ...rangeHeaders,
            Upgrade: {
              description: '`agent-workspace-contracts/<current major.minor>` (RFC 9110 §15.5.22).',
              schema: { type: 'string' },
            },
          },
          content: { 'application/json': { schema: ref(problemSchema) } },
        },
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A workspace API key (`ak_live_…`) or a browser token minted by `POST /api/tokens`.',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-aw_session',
          description:
            'The control plane’s own browser session. A deployment that sets `AW_INSTANCE_ID` names it `__Host-aw_session_<AW_INSTANCE_ID>`, so two deployments on one host keep separate sessions.',
        },
        invitationCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-aw_invitation_identity',
          description:
            'The invitation-identity cookie OIDC sign-in sets for an invitee who has no ' +
            'membership yet; it carries an identity, not a workspace. A deployment that sets ' +
            '`AW_INSTANCE_ID` names it `__Host-aw_invitation_identity_<AW_INSTANCE_ID>`.',
        },
      },
    },
  });
}

/**
 * The document as committed: sorted keys, two-space indentation, LF, one trailing newline.
 * @param {string} repoRoot
 * @returns {Promise<string>}
 */
export async function renderOpenApiDocument(repoRoot) {
  return `${JSON.stringify(await buildOpenApiDocument(repoRoot), null, 2)}\n`;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') {
    process.stderr.write('usage: generate-openapi.mjs --write | --check\n');
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const outPath = path.join(repoRoot, ...OPENAPI_OUTPUT.split('/'));
  const rendered = await renderOpenApiDocument(repoRoot);
  if (mode === '--write') {
    await writeFile(outPath, rendered, 'utf8');
    process.stdout.write(`wrote ${OPENAPI_OUTPUT}\n`);
    return;
  }
  const existing = await readFile(outPath, 'utf8').catch(() => null);
  if (existing !== rendered) {
    const state = existing === null ? 'missing' : 'stale';
    process.stderr.write(`${state}: ${OPENAPI_OUTPUT} — run \`pnpm docs:generate\`\n`);
    process.exit(1);
  }
  process.stdout.write(`${OPENAPI_OUTPUT} is current\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
