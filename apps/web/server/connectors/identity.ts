import { CONNECTORS_PROBLEM_CODES } from '@indx-workspace/contracts/connectors';

import { problem, type ApiResult } from '../http/result';

/** The stable public code for a connector that cannot carry the assertion header (ADR-0142 D1). */
export const CONNECTOR_IDENTITY_UNSUPPORTED = 'connector_identity_unsupported';

/** The `422` for a stdio connector that declares `identity`: it has no request to carry a header. */
export function connectorIdentityUnsupported(): ApiResult {
  return problem(
    CONNECTORS_PROBLEM_CODES.connector_identity_unsupported,
    CONNECTOR_IDENTITY_UNSUPPORTED,
    'a stdio connector cannot carry the identity assertion (ADR-0142); declare "identity" on an http, sse or openapi connector.',
  );
}
