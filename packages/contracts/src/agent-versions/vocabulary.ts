import { z } from 'zod';

/**
 * Issue #440 (S1-02): the vocabulary of agent versions (ADR-0101). A version is an immutable,
 * numbered snapshot of one agent's definition and its surfaces (ADR-0108); an environment's
 * pointer names the version it runs. `aw push` (`via: 'aw-push'`), the browser (`via: 'ui'`),
 * a plain API client (`via: 'api'`) and the Builder (`via: 'builder'`) all save one the same
 * way. The routes arrive with S1-05 and S1-06; this module is their shared shape.
 */
export const AGENT_VERSION_VIAS = ['ui', 'aw-push', 'api', 'builder'] as const;
export type AgentVersionVia = (typeof AGENT_VERSION_VIAS)[number];
/** {@link AGENT_VERSION_VIAS} as a schema (ADR-0101; issue #440). */
export const AgentVersionViaSchema = z.enum(AGENT_VERSION_VIAS);

/**
 * The `via` values a client may send: every one but `'builder'`. The Builder saves a version
 * in-process, so a request body that named it would only let a member pose as the Builder in the
 * version history (issue #1847). Derived from {@link AGENT_VERSION_VIAS}, never a second list.
 */
export const CLIENT_AGENT_VERSION_VIAS = AGENT_VERSION_VIAS.filter(
  (via): via is Exclude<AgentVersionVia, 'builder'> => via !== 'builder',
);
export type ClientAgentVersionVia = (typeof CLIENT_AGENT_VERSION_VIAS)[number];
/** {@link CLIENT_AGENT_VERSION_VIAS} as a schema, for every request and draft a client sends. */
export const ClientAgentVersionViaSchema = z.enum(CLIENT_AGENT_VERSION_VIAS);

/**
 * The environments a pointer may name (ADR-0101, ADR-0108; issues #440, #612). `local` is the
 * working draft `aw push` moves; `production` is what public surfaces serve. Moving `production`
 * rewrites nothing but its pointer. `preview` is not an environment (P-6).
 */
export const AGENT_ENVIRONMENTS = ['local', 'production'] as const;
export type AgentEnvironment = (typeof AGENT_ENVIRONMENTS)[number];
/** {@link AGENT_ENVIRONMENTS} as a schema (ADR-0101; issue #440). */
export const AgentEnvironmentSchema = z.enum(AGENT_ENVIRONMENTS);

/** The most surfaces one version may carry (ADR-0101, ADR-0108; issue #440). */
export const AGENT_VERSION_SURFACES_MAX = 16;

/** The longest version summary, in characters (ADR-0101; issue #440). */
export const AGENT_VERSION_SUMMARY_MAX_LENGTH = 200;

/**
 * The largest version number: PostgreSQL's `integer` maximum, so a number the contract accepts is
 * one S1-04's version store can hold and look up — a larger one is refused as a bad request here
 * rather than overflowing the column as a `500` (ADR-0101; issue #440).
 */
export const AGENT_VERSION_NUMBER_MAX = 2_147_483_647;

/** A version number: the first version of an agent is `1`. */
export const AgentVersionNumberSchema = z.number().int().min(1).max(AGENT_VERSION_NUMBER_MAX);
