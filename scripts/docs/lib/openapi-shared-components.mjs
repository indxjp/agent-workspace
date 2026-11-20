/**
 * The fixed parts of the OpenAPI document that do not depend on any route: the contracts-version
 * parameter, headers and responses, and the security schemes (ADR-0078).
 */
import { ref } from './openapi-bodies.mjs';

/**
 * @typedef {object} VersionSurface
 * @property {string} versionHeader name of the contracts-version request header
 * @property {string} minimumHeader name of the minimum-version response header
 * @property {string} unsupportedStatus status of `contracts_version_unsupported`
 * @property {string} malformedStatus status of `contracts_version_malformed`
 */

export const UNSUPPORTED_CODE = 'contracts_version_unsupported';
export const MALFORMED_CODE = 'contracts_version_malformed';

/** The two range headers every success and problem response carries. */
export const rangeHeadersOf = (/** @type {VersionSurface} */ { versionHeader, minimumHeader }) => ({
  [versionHeader]: { $ref: '#/components/headers/ContractsVersion' },
  [minimumHeader]: { $ref: '#/components/headers/ContractsMinimumVersion' },
});

/** @param {VersionSurface} surface */
function contractsVersionParameter({ versionHeader, unsupportedStatus, malformedStatus }) {
  return {
    in: 'header',
    name: versionHeader,
    required: false,
    description:
      'The contracts version (`MAJOR.MINOR.PATCH`) the client was built against. A version ' +
      `outside the served range is refused with \`${unsupportedStatus} ${UNSUPPORTED_CODE}\`; one ` +
      `that is not a version with \`${malformedStatus} ${MALFORMED_CODE}\`. A request without it ` +
      'is accepted and served at the current version (ADR-0078).',
    schema: {
      pattern: '^(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})$',
      type: 'string',
    },
  };
}

const VERSION_HEADERS = {
  ContractsVersion: {
    description: 'The newest contracts version the server serves.',
    schema: { type: 'string' },
  },
  ContractsMinimumVersion: {
    description: 'The oldest contracts version the server still serves.',
    schema: { type: 'string' },
  },
};

/** @param {VersionSurface} surface @param {string} problemSchema component name */
function problemResponses(surface, problemSchema) {
  const rangeHeaders = rangeHeadersOf(surface);
  const content = { 'application/json': { schema: ref(problemSchema) } };
  return {
    Problem: {
      description: 'The standard error envelope. Branch on `error.code`, never on `message`.',
      headers: rangeHeaders,
      content,
    },
    BadRequest: {
      description:
        `\`${MALFORMED_CODE}\` when the \`${surface.versionHeader}\` header is not a version, ` +
        'refused before authentication; otherwise the route’s own validation failure.',
      headers: rangeHeaders,
      content,
    },
    ContractsVersionUnsupported: {
      description:
        `\`${UNSUPPORTED_CODE}\`: the client’s contracts version is outside the served range, ` +
        'refused before authentication; the range headers say which side must upgrade.',
      headers: {
        ...rangeHeaders,
        Upgrade: {
          description: '`agent-workspace-contracts/<current major.minor>` (RFC 9110 §15.5.22).',
          schema: { type: 'string' },
        },
      },
      content,
    },
  };
}

const SECURITY_SCHEMES = {
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
};

/**
 * `components` of the document, around the generated `schemas`.
 * @param {Record<string, unknown>} schemas @param {VersionSurface} surface
 * @param {string} problemSchema component name of the problem envelope
 */
export function buildComponents(schemas, surface, problemSchema) {
  return {
    schemas,
    parameters: { ContractsVersion: contractsVersionParameter(surface) },
    headers: VERSION_HEADERS,
    responses: problemResponses(surface, problemSchema),
    securitySchemes: SECURITY_SCHEMES,
  };
}
