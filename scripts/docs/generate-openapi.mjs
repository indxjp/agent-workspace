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
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bodyContent, createSchemaRegistry } from './lib/openapi-bodies.mjs';
import { loadContracts } from './lib/openapi-contracts.mjs';
import {
  MALFORMED_CODE,
  UNSUPPORTED_CODE,
  buildComponents,
  rangeHeadersOf,
} from './lib/openapi-shared-components.mjs';

/** Repo-relative path of the emitted document. */
export const OPENAPI_OUTPUT = 'docs/sdk/site/openapi.json';

/** The OpenAPI `security` of a route whose credential is not the default (`ApiRoute.security`). */
const ROUTE_SECURITY = {
  none: [],
  'session-cookie': [{ sessionCookie: [] }],
  'invitation-identity': [{ invitationCookie: [] }],
  'user-token': [{ bearerAuth: [] }],
  'endpoint-credential': [{ bearerAuth: [] }],
};

const PATH_PARAMETER = /:([A-Za-z][A-Za-z0-9]*)/gu;

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
 * @typedef {import('./lib/openapi-bodies.mjs').ApiBody} ApiBody
 * @typedef {import('./lib/openapi-bodies.mjs').ComponentResolver} ComponentResolver
 * @typedef {import('./lib/openapi-shared-components.mjs').VersionSurface} VersionSurface
 * @typedef {Awaited<ReturnType<typeof loadContracts>>['API_ROUTES'][number]} ApiRoute
 */

/**
 * @typedef {object} RouteContext
 * @property {ComponentResolver} component
 * @property {VersionSurface} surface
 */

/** @param {ApiRoute} route */
function pathParametersOf(route) {
  return [...route.path.matchAll(PATH_PARAMETER)].map((match) => ({
    in: 'path',
    name: match[1],
    required: true,
    schema: { type: 'string' },
  }));
}

/** @param {ApiRoute} route @param {RouteContext} context */
function responsesOf(route, { component, surface }) {
  /** @type {Record<string, unknown>} */
  const responses = {
    [surface.malformedStatus]: { $ref: '#/components/responses/BadRequest' },
    [surface.unsupportedStatus]: { $ref: '#/components/responses/ContractsVersionUnsupported' },
    default: { $ref: '#/components/responses/Problem' },
  };
  for (const success of route.success) {
    responses[String(success.status)] = {
      description: success.status === 204 ? 'No content.' : 'Success.',
      headers: rangeHeadersOf(surface),
      ...(success.body.kind === 'none'
        ? {}
        : { content: bodyContent(success.body, 'output', component) }),
    };
  }
  return responses;
}

/**
 * The accepted request media types: the current body, then each deprecated one flagged as such.
 * @param {ApiRoute} route @param {ApiBody} request the route's current request body
 * @param {ComponentResolver} component
 */
function requestBodyOf(route, request, component) {
  /** @type {Record<string, Record<string, unknown>>} */
  const accepted = { ...bodyContent(request, 'input', component) };
  for (const older of route.deprecatedRequests ?? []) {
    for (const [mediaType, media] of Object.entries(bodyContent(older, 'input', component))) {
      // OpenAPI has no per-media-type flag; the schema's own `deprecated` carries it.
      const schema = /** @type {Record<string, unknown>} */ (media['schema']);
      accepted[mediaType] = { ...media, schema: { ...schema, deprecated: true } };
    }
  }
  return { content: accepted, required: true };
}

/** @param {ApiRoute} route */
function parametersOf(route) {
  return [
    ...pathParametersOf(route),
    ...(route.headers ?? []).map((header) => ({
      in: 'header',
      name: header.name,
      required: header.required,
      description: header.description,
      schema: { type: 'string' },
    })),
    { $ref: '#/components/parameters/ContractsVersion' },
  ];
}

/** @param {ApiRoute} route @param {RouteContext} context */
function operationOf(route, context) {
  /** @type {Record<string, unknown>} */
  const operation = {
    ...(route.description === undefined ? {} : { description: route.description }),
    operationId: route.operationId,
    parameters: parametersOf(route),
    responses: responsesOf(route, context),
    summary: route.summary,
    tags: [route.tag],
    'x-agent-workspace-feature': route.feature,
  };
  if (route.request !== undefined && route.request.kind !== 'none') {
    operation['requestBody'] = requestBodyOf(route, route.request, context.component);
  }
  if (route.deprecated === true) operation['deprecated'] = true;
  if (route.security !== undefined) {
    const security = ROUTE_SECURITY[route.security];
    if (security === undefined) throw new Error(`unexpected security ${route.security}`);
    operation['security'] = security;
  }
  return operation;
}

/**
 * `paths` of the document: one item per route path, one operation per method.
 * @param {readonly ApiRoute[]} routes @param {RouteContext} context
 */
function buildPaths(routes, context) {
  /** @type {Record<string, Record<string, unknown>>} */
  const paths = {};
  const operationIds = new Set();
  for (const route of routes) {
    if (operationIds.has(route.operationId)) {
      throw new Error(`operationId ${route.operationId} is used twice`);
    }
    operationIds.add(route.operationId);
    const item = (paths[route.path.replace(PATH_PARAMETER, '{$1}')] ??= {});
    const method = route.method.toLowerCase();
    if (method in item) throw new Error(`${route.method} ${route.path} is catalogued twice`);
    item[method] = operationOf(route, context);
  }
  return paths;
}

/** @param {{ version: string, license: string }} manifest */
function buildInfo(manifest) {
  return {
    title: 'Agent Workspace API',
    version: manifest.version,
    description:
      'The public `/api/**` surface of the Agent Workspace control plane, generated from ' +
      '`@indx-workspace/contracts` by `scripts/docs/generate-openapi.mjs`. Never edit it by ' +
      'hand: the Zod schemas are the source of truth. Every failure is the standard envelope ' +
      '`{ error: { code, message, details?, detail? } }`.',
    license: { name: manifest.license, identifier: manifest.license },
  };
}

/**
 * Build the document.
 * @param {string} repoRoot
 * @returns {Promise<Record<string, unknown>>}
 */
export async function buildOpenApiDocument(repoRoot) {
  const contracts = await loadContracts();
  const { API_ROUTES } = contracts;
  const problemCodes = contracts.CONTRACTS_VERSION_PROBLEM_CODES;
  /** @type {VersionSurface} */
  const surface = {
    versionHeader: contracts.CONTRACTS_VERSION_HEADER,
    minimumHeader: contracts.CONTRACTS_MINIMUM_VERSION_HEADER,
    unsupportedStatus: String(problemCodes[UNSUPPORTED_CODE]),
    malformedStatus: String(problemCodes[MALFORMED_CODE]),
  };
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/contracts/package.json'), 'utf8'),
  );
  const { schemas, component } = createSchemaRegistry(contracts.API_SCHEMAS);

  const paths = buildPaths(API_ROUTES, { component, surface });
  const problemSchema = component('ApiProblemSchema', 'output');
  const tags = [...new Set(API_ROUTES.map((route) => route.tag))].sort().map((name) => ({ name }));

  return sortKeysDeep({
    openapi: '3.1.0',
    info: buildInfo(manifest),
    servers: [{ url: 'http://localhost:3000', description: 'A control plane on this machine' }],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    tags,
    paths,
    components: buildComponents(schemas, surface, problemSchema),
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
