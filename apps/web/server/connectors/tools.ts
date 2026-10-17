/**
 * Registration of the tool connectors (`openapi`, `postgres`; ADR-0113 SD1, SD4, SD15, C15). One
 * function, {@link admitToolConnector}, answers both the dry run and the save: every refusal is
 * produced before it looks at `dryRun`, so the two return the same problem by construction (the
 * C8 rule). The handlers only decide what to do with an admitted body.
 *
 * Stages, first failure answers: the contracts schema → OpenAPI normalisation → the egress
 * pre-check of the host the gateway will call (never fetched here).
 */
import { checkEgress, loadEgressPolicyFromEnv } from '@agent-workspace/core';
import type { ToolConnectorKind } from '@agent-workspace/core/db';
import {
  CreateToolConnectorRequestSchema,
  POSTGRES_TOOL_OPERATION_NAMES,
  problemCodeOfIssue,
  TOOL_CONNECTOR_PROBLEM_CODES,
} from '@indx-workspace/contracts/tool-connectors';

import { normaliseOpenApi } from '../openapi/normalise';

/** A status and a body, the shape of `handlers.ts`'s `ApiResult` (kept here to avoid a cycle). */
export interface ToolResult {
  readonly status: number;
  readonly body: unknown;
}

function problem(
  status: number,
  code: string,
  message: string,
  details: readonly string[],
): ToolResult {
  return { status, body: { error: { code, message, details: [...details] } } };
}

export type CheckConnectorEgress = (
  url: string,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;

/** The real egress policy, read from the environment. A test substitutes its own. */
export const defaultCheckConnectorEgress: CheckConnectorEgress = async (url) => {
  const decision = await checkEgress(url, loadEgressPolicyFromEnv());
  return decision.ok ? { ok: true } : { ok: false, reason: decision.reason };
};

/** What the store writes for a tool connector: `tool_config` and the credential to seal. */
export interface ToolConnectorWrite {
  readonly kind: ToolConnectorKind;
  readonly name: string;
  /** `{ openapi, parameters }` or `{ postgres }`. */
  readonly toolConfig: Readonly<Record<string, unknown>>;
  /** The document text an `openapi` connector was registered with, verbatim. `null` for postgres. */
  readonly openapiDocument: string | null;
  /** The raw credential, sealed as a secret by the store and never returned. */
  readonly credential: string | null;
}

export type ToolAdmission =
  | {
      readonly ok: true;
      readonly write: ToolConnectorWrite;
      readonly dryRun: boolean;
      /** The `200` a dry run answers: the `TestConnectionOutcome` the route already declares. */
      readonly dryRunResult: ToolResult;
    }
  | { readonly ok: false; readonly result: ToolResult };

function refusal(
  code: keyof typeof TOOL_CONNECTOR_PROBLEM_CODES,
  details: readonly string[],
): { readonly ok: false; readonly result: ToolResult } {
  return {
    ok: false,
    result: problem(
      TOOL_CONNECTOR_PROBLEM_CODES[code],
      code,
      'The connector could not be registered from this body.',
      details,
    ),
  };
}

function dryRunResult(
  kind: ToolConnectorKind,
  serverName: string | null,
  toolCount: number,
): ToolResult {
  return {
    status: 200,
    body: {
      ok: true,
      kind: 'ok',
      message: `The ${kind} connector is valid; nothing was saved.`,
      serverName,
      serverVersion: null,
      toolCount,
    },
  };
}

/** Admit one tool connector create (or full-replacement) body. See this file's header. */
export async function admitToolConnector(
  rawBody: unknown,
  checkConnectorEgress: CheckConnectorEgress = defaultCheckConnectorEgress,
): Promise<ToolAdmission> {
  const parsed = CreateToolConnectorRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const details = issues.map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join('.')}: ${issue.message}`,
    );
    const codes = issues.map(problemCodeOfIssue);
    const first = codes[0];
    if (first === null || first === undefined || codes.includes(null)) {
      return {
        ok: false,
        result: problem(
          400,
          'invalid_body',
          'The connector could not be created from this body.',
          details,
        ),
      };
    }
    return refusal(first, details);
  }
  const body = parsed.data;
  const dryRun = body.dryRun === true;

  if (body.kind === 'postgres') {
    // ponytail: host-only pre-check via an https URL; S2-02e adds a TCP form in packages/core/src/net
    const host = new URL(body.credential).hostname;
    const egress = await checkConnectorEgress(`https://${host}/`);
    if (!egress.ok) {
      return refusal('connector_spec_invalid', [
        'credential: the database host is refused by the egress policy',
      ]);
    }
    return {
      ok: true,
      dryRun,
      dryRunResult: dryRunResult('postgres', null, POSTGRES_TOOL_OPERATION_NAMES.length),
      write: {
        kind: 'postgres',
        name: body.name,
        toolConfig: {
          postgres: { tables: [...body.tables], readOnly: body.readOnly, maxRows: body.maxRows },
        },
        openapiDocument: null,
        credential: body.credential,
      },
    };
  }

  const normalised = normaliseOpenApi({
    document: body.document,
    baseUrl: body.baseUrl,
    allow: body.allow,
    auth: body.auth,
  });
  if (!normalised.ok) return refusal(normalised.code, normalised.details);
  const egress = await checkConnectorEgress(normalised.openapi.baseUrl);
  if (!egress.ok) {
    const field = normalised.baseUrlFromServers ? 'servers' : 'baseUrl';
    return refusal('connector_spec_invalid', [`${field}: is not reachable: ${egress.reason}`]);
  }
  return {
    ok: true,
    dryRun,
    dryRunResult: dryRunResult(
      'openapi',
      normalised.openapi.spec.title ?? null,
      normalised.openapi.operations.length,
    ),
    write: {
      kind: 'openapi',
      name: body.name,
      toolConfig: { openapi: normalised.openapi, parameters: normalised.parameters },
      openapiDocument: body.document,
      credential: body.credential ?? null,
    },
  };
}
