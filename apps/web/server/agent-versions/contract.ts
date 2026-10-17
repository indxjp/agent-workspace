/**
 * The wire edge of the version routes (S1-05, issue #443; ADR-0101): the serialisers from core's
 * version records into `@indx-workspace/contracts/agent-versions`' shapes, and the request-body
 * byte bound.
 *
 * Core stores a version body as `jsonb` and hands it back as `unknown` (it cannot import the
 * contracts). Every body is therefore re-parsed with `AgentVersionBodySchema` on its way out. A row
 * that fails the parse was not written by this server's pipeline — the only writer — so it is an
 * invariant break and throws (surfacing as `500 internal_error`), never a row silently dropped from
 * the listing or served unparsed.
 */
import type {
  AgentPointerMoveRecord,
  AgentVersionListing,
  AgentVersionPointerRecord,
  AgentVersionRecord,
} from '@agent-workspace/core/db';
import {
  AGENT_VERSION_SUMMARY_MAX_LENGTH,
  AGENT_VERSION_SURFACES_MAX,
  AgentVersionBodySchema,
  type AgentPointerMove,
  type AgentVersionEvaluation,
  type AgentVersionListResponse,
  type AgentVersionPointer,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import {
  AGENT_DEFINITION_FILE_PATH_MAX_LENGTH,
  AGENT_DEFINITION_MAX_REFERENCES,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
} from '@indx-workspace/contracts/agents';
import { SKILL_NAME_MAX_LENGTH } from '@indx-workspace/contracts/skills';
import {
  SURFACE_DISCLAIMER_MAX_LENGTH,
  SURFACE_GREETING_MAX_LENGTH,
  SURFACE_LOGO_URL_MAX_LENGTH,
  SURFACE_NAME_MAX_LENGTH,
  SURFACE_SUGGESTED_PROMPT_MAX_LENGTH,
  SURFACE_SUGGESTED_PROMPTS_MAX,
} from '@indx-workspace/contracts/surfaces';
import { SURFACE_TITLE_MAX_LENGTH } from '@indx-workspace/contracts/setup';

import { MAX_REQUEST_BODY_BYTES } from '../agents/http';

/** The most bytes one JSON code unit can take on the wire: the `\uXXXX` escape. */
const JSON_WORST_CASE_BYTES_PER_CODE_UNIT = 6;

/** Quotes, a comma and the key or object braces around one bounded string or list entry. */
const PER_ENTRY_OVERHEAD_BYTES = 64;

/**
 * Room for everything the contract does not bound by a constant: the envelope's keys, the
 * permissions, the limits, the theme's short fields, and the policy's tool rule lists, which
 * `AgentToolPolicySchema` leaves unbounded. A policy whose rule lists exceed this allowance is
 * refused `413 request_body_too_large` rather than held in memory.
 */
const UNBOUNDED_FIELDS_ALLOWANCE_BYTES = 256 * 1024;

/** The bytes one string of at most `length` code units can take, escaped at its worst. */
function boundedString(length: number): number {
  return length * JSON_WORST_CASE_BYTES_PER_CODE_UNIT + PER_ENTRY_OVERHEAD_BYTES;
}

/** One surface at every bound `SurfaceDefinitionSchema` declares. */
const SURFACE_MAX_BYTES =
  boundedString(SURFACE_NAME_MAX_LENGTH) +
  boundedString(AGENT_NAME_MAX_LENGTH) +
  // The surface title and a text logo, each at the title bound.
  2 * boundedString(SURFACE_TITLE_MAX_LENGTH) +
  boundedString(SURFACE_LOGO_URL_MAX_LENGTH) +
  boundedString(SURFACE_GREETING_MAX_LENGTH) +
  boundedString(SURFACE_DISCLAIMER_MAX_LENGTH) +
  SURFACE_SUGGESTED_PROMPTS_MAX * boundedString(SURFACE_SUGGESTED_PROMPT_MAX_LENGTH);

/**
 * The largest create-version body the routes read, in bytes (S1-05 risk 4).
 *
 * **Derived, not chosen**, the way `../agents/http.ts`'s `MAX_REQUEST_BODY_BYTES` is: every field
 * the contract bounds is counted at its bound with every code unit escaped to its worst case —
 * `instructions`, the three reference lists at {@link AGENT_DEFINITION_MAX_REFERENCES} each (file
 * paths at their own bound), the policy's skill allowlist (which may only name assigned skills),
 * {@link AGENT_VERSION_SURFACES_MAX} surfaces, the summary and the agent's own names — plus
 * {@link UNBOUNDED_FIELDS_ALLOWANCE_BYTES}. So no body the contract accepts is refused by the
 * bound (`contract.test.ts` sends a maximal one), and a body that cannot parse is refused while it
 * streams rather than after it is in memory. If a contract bound moves, this moves with it.
 */
export const MAX_AGENT_VERSION_BODY_BYTES =
  boundedString(AGENT_INSTRUCTIONS_MAX_LENGTH) +
  AGENT_DEFINITION_MAX_REFERENCES * boundedString(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH) +
  // `resources.skills` and the policy's allowlist of them.
  2 * AGENT_DEFINITION_MAX_REFERENCES * boundedString(SKILL_NAME_MAX_LENGTH) +
  AGENT_DEFINITION_MAX_REFERENCES * boundedString(AGENT_NAME_MAX_LENGTH) +
  AGENT_VERSION_SURFACES_MAX * SURFACE_MAX_BYTES +
  boundedString(AGENT_VERSION_SUMMARY_MAX_LENGTH) +
  // The agent's name, model, model connection and runtime profile.
  3 * boundedString(AGENT_NAME_MAX_LENGTH) +
  boundedString(AGENT_MODEL_MAX_LENGTH) +
  UNBOUNDED_FIELDS_ALLOWANCE_BYTES;

/**
 * The largest `PUT /api/agents/:id/pointers` body, in bytes: `{"environment": …, "version": …}`
 * is two short fields, so a few hundred bytes would do; one KiB leaves room for whitespace.
 */
export const MAX_POINTER_BODY_BYTES = 1024;

/**
 * Room for the create-from-version envelope around a version draft: the `version` and `dryRun`
 * keys and their punctuation. Generous, because a few hundred bytes here cost nothing.
 */
const CREATE_FROM_VERSION_ENVELOPE_BYTES = 1024;

/**
 * The largest `POST /api/agents` body the route reads, in bytes (S1-06 risk 2). One route serves
 * three body forms — legacy, compound and create-from-version — and the bound is applied while the
 * body streams, before the form is known, so it is the larger of the legacy bound and a maximal
 * version draft in its envelope. Field bounds still protect the rows; this protects the process.
 * Derived from both bounds, so it moves when either does.
 */
export const MAX_CREATE_AGENT_BODY_BYTES = Math.max(
  MAX_REQUEST_BODY_BYTES,
  MAX_AGENT_VERSION_BODY_BYTES + CREATE_FROM_VERSION_ENVELOPE_BYTES,
);

/** One stored version as `AgentVersionResourceSchema` publishes it. Throws on a corrupt body. */
export function toAgentVersionResource(record: AgentVersionRecord): AgentVersionResource {
  const body = AgentVersionBodySchema.safeParse(record.body);
  if (!body.success) {
    throw new Error(
      `Agent version ${record.id} holds a body that does not parse as AgentVersionBodySchema; ` +
        'the version pipeline is its only writer, so this is a broken invariant.',
    );
  }
  return {
    id: record.id,
    agentId: record.agentId,
    workspaceId: record.workspaceId,
    number: record.number,
    summary: record.summary,
    via: record.via,
    body: body.data,
    createdByPrincipalId: record.createdByPrincipalId,
    createdAt: record.createdAt.toISOString(),
  };
}

/** One pointer as `AgentVersionPointerSchema` publishes it. */
export function toAgentVersionPointer(record: AgentVersionPointerRecord): AgentVersionPointer {
  return {
    environment: record.environment,
    number: record.number,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** One pointer history row as `AgentPointerMoveSchema` publishes it (issue #615). */
export function toAgentPointerMove(record: AgentPointerMoveRecord): AgentPointerMove {
  return {
    environment: record.environment,
    number: record.number,
    reason: record.reason,
    movedByPrincipalId: record.movedByPrincipalId,
    movedAt: record.movedAt.toISOString(),
  };
}

/**
 * An agent's versions, pointers and latest pointer moves as `AgentVersionListResponseSchema`
 * publishes them.
 */
export function toAgentVersionListResponse(
  listing: AgentVersionListing,
  moves: readonly AgentPointerMoveRecord[],
  evaluations: readonly AgentVersionEvaluation[],
): AgentVersionListResponse {
  return {
    items: listing.versions.map(toAgentVersionResource),
    pointers: listing.pointers.map(toAgentVersionPointer),
    moves: moves.map(toAgentPointerMove),
    evaluations,
    materialised:
      listing.versions.find((version) => version.id === listing.materialisedVersionId)?.number ??
      null,
  };
}
