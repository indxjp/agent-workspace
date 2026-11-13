import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION_HEADER,
} from '@indx-workspace/contracts';
import { API_ROUTES } from '@indx-workspace/contracts/routes';
import { Validator } from '@seriousme/openapi-schema-validator';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildOpenApiDocument,
  OPENAPI_OUTPUT,
  renderOpenApiDocument,
} from '../../scripts/docs/generate-openapi.mjs';
import { document, rendered, repoRoot, routeKey as key } from './openapi.test-support.js';

/** The quoted `METHOD /path` entries of one `new Set([...])` in the authorisation matrix. */
async function matrixRouteSet(name: string): Promise<Set<string>> {
  const source = await readFile(
    path.join(repoRoot, 'apps/web/server/rbac/authorisation-matrix.test-support.ts'),
    'utf8',
  );
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`, 'u').exec(source);
  if (match?.[1] === undefined) throw new Error(`${name} not found in the authorisation matrix`);
  return new Set([...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1] ?? ''));
}

describe('the emitted document', () => {
  it('validates against the OpenAPI 3.1 schema', validatesAgainstOpenAPI31Schema);

  it('is deterministic: two runs, one output', isDeterministicTwoRunsOneOutput);

  it('is committed as generated', isCommittedGenerated);

  it(
    'describes the error envelope, the contracts-version headers and the event stream',
    describesErrorEnvelopeContractsVersionHeadersEvent,
  );

  it(
    'emits a route’s declared request headers as header parameters (S-6, #250)',
    emitsRouteSDeclaredRequestHeadersHeader,
  );
});

describe('per-route credentials', () => {
  it(
    'marks exactly the public and identity-only routes of the authorisation matrix',
    marksExactlyPublicIdentityOnlyRoutesAuthorisation,
  );

  it('emits the route security in place of the global one', emitsRouteSecurityPlaceGlobalOne);
});

describe('POST /api/skills (#1925 item 11)', () => {
  it(
    'describes the multipart/form-data import: a text `name`, then one `file` part per file',
    describesMultipartFormDataImportTextName,
  );

  it('keeps the JSON + base64 body, marked deprecated', keepsJSONBase64BodyMarkedDeprecated);
});
const requestContent = (): Record<string, Record<string, unknown>> => {
  const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
  const body = paths['/api/skills']?.['post']?.['requestBody'] as Record<string, unknown>;
  return body['content'] as Record<string, Record<string, unknown>>;
};

async function validatesAgainstOpenAPI31Schema() {
  const validator = new Validator();
  const result = await validator.validate(document);
  expect(result.errors ?? []).toEqual([]);
  expect(result.valid).toBe(true);
  expect(validator.version).toBe('3.1');
}

async function isDeterministicTwoRunsOneOutput() {
  expect(await renderOpenApiDocument(repoRoot)).toBe(rendered);
  expect(rendered.endsWith('}\n')).toBe(true);
  expect(rendered.includes('\r')).toBe(false);
}

async function isCommittedGenerated() {
  const committed = await readFile(path.join(repoRoot, ...OPENAPI_OUTPUT.split('/')), 'utf8');
  expect(committed, 'run `pnpm docs:generate`').toBe(rendered);
}

async function describesErrorEnvelopeContractsVersionHeadersEvent() {
  const built = await buildOpenApiDocument(repoRoot);
  const components = built['components'] as Record<string, Record<string, unknown>>;
  expect(Object.keys(components['responses'] ?? {})).toEqual([
    'BadRequest',
    'ContractsVersionUnsupported',
    'Problem',
  ]);
  expect(JSON.stringify(components['parameters'])).toContain(CONTRACTS_VERSION_HEADER);
  const unsupported = components['responses']?.['ContractsVersionUnsupported'] as Record<
    string,
    Record<string, unknown>
  >;
  expect(Object.keys(unsupported['headers'] ?? {}).sort()).toEqual(
    ['Upgrade', CONTRACTS_VERSION_HEADER, CONTRACTS_MINIMUM_VERSION_HEADER].sort(),
  );
  const problem = components['schemas']?.['ApiProblem'] as Record<string, unknown>;
  expect(JSON.stringify(problem)).toContain('"code"');
  const paths = built['paths'] as Record<string, Record<string, Record<string, unknown>>>;
  const events = paths['/api/runs/{id}/events']?.['get']?.['responses'] as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  expect(Object.keys(events['200']?.['content'] ?? {})).toEqual(['text/event-stream']);
}

async function emitsRouteSDeclaredRequestHeadersHeader() {
  const built = await buildOpenApiDocument(repoRoot);
  const paths = built['paths'] as Record<string, Record<string, Record<string, unknown>>>;
  const start = paths['/api/agents/{id}/runs']?.['post']?.['parameters'] as readonly Record<
    string,
    unknown
  >[];
  const headers = start.filter((parameter) => parameter['in'] === 'header');
  expect(headers.map(({ name, required }) => ({ name, required }))).toEqual([
    { name: 'Idempotency-Key', required: false },
  ]);
}

async function marksExactlyPublicIdentityOnlyRoutesAuthorisation() {
  const identityOnly = await matrixRouteSet('IDENTITY_ONLY_ROUTES');
  const exempt = new Set([...(await matrixRouteSet('PUBLIC_ROUTES')), ...identityOnly]);
  expect(identityOnly.size).toBeGreaterThan(0);
  const catalogued = API_ROUTES.map((route) => key(route.method, route.path));
  const expected = catalogued.filter((route) => exempt.has(route)).sort();
  const marked = API_ROUTES.filter((route) => route.security !== undefined)
    .map((route) => key(route.method, route.path))
    .sort();
  expect(marked).toEqual(expected);
  // Every identity-only route proves its caller by a credential of its own: the invitation
  // cookie for `/accept`, or (ADR-0083) the user token for the two routes that act on it, or
  // (ADR-0135) the endpoint credential of a published agent's A2A routes.
  const identityProofs = API_ROUTES.filter(
    (route) =>
      route.security === 'invitation-identity' ||
      route.security === 'user-token' ||
      route.security === 'endpoint-credential',
  ).map((route) => key(route.method, route.path));
  expect(identityProofs).toEqual(catalogued.filter((route) => identityOnly.has(route)));
  const invitationIdentity = API_ROUTES.filter(
    (route) => route.security === 'invitation-identity',
  ).map((route) => key(route.method, route.path));
  expect(invitationIdentity).toEqual(['POST /api/invitations/:id/accept']);
}

function emitsRouteSecurityPlaceGlobalOne() {
  const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
  expect(paths['/api/setup/runtime-detect']?.['get']?.['security']).toEqual([]);
  expect(paths['/api/invitations/{id}/accept']?.['post']?.['security']).toEqual([
    { invitationCookie: [] },
  ]);
  expect(paths['/api/me']?.['get']?.['security']).toBeUndefined();
}

function describesMultipartFormDataImportTextName() {
  expect(requestContent()['multipart/form-data']).toMatchObject({
    schema: {
      type: 'object',
      required: ['name', 'file'],
      properties: {
        name: { type: 'string' },
        file: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', contentMediaType: 'application/octet-stream' },
        },
      },
    },
    encoding: { name: { contentType: 'text/plain' } },
  });
}

function keepsJSONBase64BodyMarkedDeprecated() {
  expect(requestContent()['application/json']?.['schema']).toMatchObject({ deprecated: true });
}
