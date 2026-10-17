import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_MUTABLE_FIELDS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PERMISSION_KEYS,
  type AgentPermissions,
  type AgentPolicy,
  type AgentResource,
  type CreateAgentInput,
  type UpdateAgentPatch,
} from '../../contracts/agents';

/**
 * Server-side parsing and serialization for the five agent routes of spec §34. The dependency-light
 * wire schemas and DTOs live in `apps/web/contracts/agents.ts`; persistence-only `AgentRecord` and
 * the route parsers stay here so browser code cannot acquire a server dependency.
 *
 * ## Why this parser is still hand-written
 *
 * The parsers predate the shared Zod response schemas and remain hand-written because their
 * accumulated, field-specific error messages are part of the request contract. Both layers import
 * their vocabulary and normalized input types from the shared contract, so browser, parser, and
 * serializer no longer maintain competing DTOs.
 *
 * The field rules below match the database constraints and spec §17. Where a bound had to be
 * chosen that neither states, it is named in
 * docs/adr/W1-CP-05-input-bounds.md.
 *
 * ## How every parser here is written (ADR-0015)
 *
 * Each one parses before it compares, ends in a total `else` that rejects and names what it
 * rejected, and returns a discriminated result rather than throwing or returning `undefined`.
 * No branch reaches an accept path because a condition was falsy: acceptance is always a
 * positive assertion about a value whose type has already been established.
 */

/** A parse either produced a value, or produced the reasons it could not. Never both, never neither. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * One agent as the store holds it — the `agents` table's columns, with timestamps as `Date`.
 *
 * `workspaceId` is present because the record is the store's, not the wire's; {@link toAgentResource}
 * decides what crosses the wire.
 */
export interface AgentRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly instructions: string;
  readonly modelConnectionId: string | null;
  readonly model: string | null;
  readonly runtimeProfileId: string | null;
  readonly permissions: AgentPermissions;
  /** `null` means "compile from `permissions` and the assigned resources" (S-13). */
  readonly policy: AgentPolicy | null;
  /** Legacy human creator attribution, or `null` when an API-key principal created the row. */
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The canonical textual form of a UUID, any version.
 *
 * `agents.id` and `agents.model_connection_id` are `uuid` columns, so a non-UUID can never match a
 * row. Rejecting it here turns a guaranteed-empty query into a 400 that says why. The pattern is
 * deliberately not version-locked: `gen_random_uuid()` produces v4 today, and pinning the version
 * digit would reject a valid id if that ever changes.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a string in canonical UUID form. Everything else — including a non-string — is false. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Describe a rejected value in an error message without stringifying something huge or cyclic. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  if (type === 'string') return 'a string';
  if (type === 'object') return 'an object';
  return `a ${type}`;
}

/** A plain JSON object: not null, not an array, not a class instance from somewhere else. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Does the body carry this key at all? `undefined` under a present key still counts as present. */
function hasKey(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// ── Field parsers ───────────────────────────────────────────────────────────────────────────
//
// Each returns a `ParseResult` so a caller can collect every error in one response rather than
// making a client fix one field per round trip.

/**
 * `agents.name`: a non-blank string, trimmed, at most {@link AGENT_NAME_MAX_LENGTH} characters.
 *
 * The trim is not cosmetic. The table carries `CHECK (length(btrim(name)) > 0)` and a unique index
 * on `(workspace_id, name)`, so `"Support"` and `"Support "` are two rows that render identically
 * in §19.5's picker. Storing the trimmed form is what makes that index mean what it looks like it
 * means. The length bound is applied to the trimmed value, for the same reason.
 */
export function parseAgentName(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') {
    return { ok: false, errors: [`name must be a string; received ${describe(raw)}.`] };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, errors: ['name must not be blank.'] };
  }
  if (trimmed.length > AGENT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      errors: [
        `name must be at most ${String(AGENT_NAME_MAX_LENGTH)} characters; received ${String(trimmed.length)}.`,
      ],
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * `agents.instructions`: any string, empty included.
 *
 * Empty is valid and means "no extra instructions" — the schema file says so, and the built-in
 * General agent of §19.5 relies on it. Unlike `name` this is **not** trimmed: an instruction block
 * is prose, and leading whitespace in it can be deliberate.
 */
export function parseAgentInstructions(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') {
    return { ok: false, errors: [`instructions must be a string; received ${describe(raw)}.`] };
  }
  if (raw.length > AGENT_INSTRUCTIONS_MAX_LENGTH) {
    return {
      ok: false,
      errors: [
        `instructions must be at most ${String(AGENT_INSTRUCTIONS_MAX_LENGTH)} characters; received ${String(raw.length)}.`,
      ],
    };
  }
  return { ok: true, value: raw };
}

/**
 * `agents.model_connection_id`: a UUID, or `null` for "the workspace default model".
 *
 * Whether that UUID names a row in `model_connections` is not checked here. The foreign key does
 * that, and the store maps its violation onto a 400 — see `store.ts`.
 */
export function parseModelConnectionId(raw: unknown): ParseResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (isUuid(raw)) return { ok: true, value: raw };
  return {
    ok: false,
    errors: [`modelConnectionId must be a UUID string or null; received ${describe(raw)}.`],
  };
}

/** `agents.runtime_profile_id`: the §14.9 profile reference, never an inlined profile. */
export function parseRuntimeProfileId(raw: unknown): ParseResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (isUuid(raw)) return { ok: true, value: raw };
  return {
    ok: false,
    errors: [`runtimeProfileId must be a UUID string or null; received ${describe(raw)}.`],
  };
}

/**
 * `agents.model`: a non-blank provider-side model id, or `null` for the workspace default.
 *
 * The pairing of `model` with `modelConnectionId` is deliberately **not** constrained here. The
 * table does not constrain it either, and §17 Step 2 shows the two as one user-facing choice
 * without saying which combinations are legal. Inventing a cross-field rule at this layer would be
 * a reading the specification does not support; see docs/adr/W1-CP-05-input-bounds.md.
 */
export function parseAgentModel(raw: unknown): ParseResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, errors: [`model must be a string or null; received ${describe(raw)}.`] };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      errors: ['model must not be blank; use null to mean "the workspace default model".'],
    };
  }
  if (trimmed.length > AGENT_MODEL_MAX_LENGTH) {
    return {
      ok: false,
      errors: [
        `model must be at most ${String(AGENT_MODEL_MAX_LENGTH)} characters; received ${String(trimmed.length)}.`,
      ],
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * `agents.permissions`: exactly the four booleans of §17 Step 4, no more and no fewer.
 *
 * The unknown-key rejection mirrors the `.strict()` on core's `AgentPermissions`, and it is there
 * for the reason that schema states: an unknown key is a permission §5's compile step does not know
 * how to map onto an SDK option, and dropping it silently is exactly the fail-open ADR-0015
 * forbids. A missing key is rejected for the stronger reason — the column has no database default,
 * because an agent whose permissions nobody chose is an agent whose blast radius nobody chose.
 */
export function parseAgentPermissions(raw: unknown): ParseResult<AgentPermissions> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`permissions must be an object; received ${describe(raw)}.`] };
  }
  const errors: string[] = [];
  const known = new Set<string>(AGENT_PERMISSION_KEYS);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      errors.push(
        `permissions.${key} is not a permission this platform knows; expected exactly ${AGENT_PERMISSION_KEYS.join(', ')}.`,
      );
    }
  }
  const collected: Record<string, boolean> = {};
  for (const key of AGENT_PERMISSION_KEYS) {
    if (!hasKey(raw, key)) {
      errors.push(`permissions.${key} is required; it has no default.`);
      continue;
    }
    const value = raw[key];
    if (typeof value !== 'boolean') {
      errors.push(`permissions.${key} must be a boolean; received ${describe(value)}.`);
      continue;
    }
    collected[key] = value;
  }
  if (errors.length > 0) return { ok: false, errors };
  // Every key of AGENT_PERMISSION_KEYS was assigned a boolean above, or `errors` is non-empty and
  // we returned. Rebuilt explicitly rather than cast, so the shape is produced, not asserted.
  return {
    ok: true,
    value: {
      readFiles: collected['readFiles'] === true,
      writeFiles: collected['writeFiles'] === true,
      runCommands: collected['runCommands'] === true,
      unrestrictedNetwork: collected['unrestrictedNetwork'] === true,
    },
  };
}

// ── Body parsers ────────────────────────────────────────────────────────────────────────────

/** Reject any key the contract does not name, so a typo is a 400 and not a silently ignored field. */
function unknownKeyErrors(body: Record<string, unknown>): string[] {
  const known = new Set<string>(AGENT_MUTABLE_FIELDS);
  return Object.keys(body)
    .filter((key) => !known.has(key))
    .map(
      (key) =>
        `${key} is not a field of an agent; expected some of ${AGENT_MUTABLE_FIELDS.join(', ')}.`,
    );
}

/**
 * `POST /api/agents` — every field is required, because every column is `NOT NULL` or explicitly
 * nullable and none of them has a default the API should be guessing at.
 *
 * `modelConnectionId` and `model` are required *keys*; `null` is the value that means "default".
 * Requiring the key rather than defaulting it means a client that omits it learns that it made a
 * choice, which is the whole point of §17 Step 2 being a step.
 */
export function parseCreateAgentInput(raw: unknown): ParseResult<CreateAgentInput> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [`the request body must be a JSON object; received ${describe(raw)}.`],
    };
  }
  const errors: string[] = [...unknownKeyErrors(raw)];

  const name = parseAgentName(raw['name']);
  if (!name.ok) errors.push(...name.errors);
  const instructions = parseAgentInstructions(raw['instructions']);
  if (!instructions.ok) errors.push(...instructions.errors);
  const modelConnectionId = parseModelConnectionId(
    hasKey(raw, 'modelConnectionId') ? raw['modelConnectionId'] : undefined,
  );
  if (!modelConnectionId.ok) errors.push(...modelConnectionId.errors);
  const model = parseAgentModel(hasKey(raw, 'model') ? raw['model'] : undefined);
  if (!model.ok) errors.push(...model.errors);
  const runtimeProfileId = parseRuntimeProfileId(
    hasKey(raw, 'runtimeProfileId') ? raw['runtimeProfileId'] : null,
  );
  if (!runtimeProfileId.ok) errors.push(...runtimeProfileId.errors);
  const permissions = parseAgentPermissions(raw['permissions']);
  if (!permissions.ok) errors.push(...permissions.errors);

  if (errors.length > 0) return { ok: false, errors };
  if (
    !name.ok ||
    !instructions.ok ||
    !modelConnectionId.ok ||
    !model.ok ||
    !runtimeProfileId.ok ||
    !permissions.ok
  ) {
    // Unreachable: `errors` is non-empty whenever any of the five failed, and we returned above.
    // Written out anyway so the accept path below is reached only after all five are known good,
    // rather than after a type assertion (ADR-0015).
    return { ok: false, errors: ['the request body could not be parsed.'] };
  }
  return {
    ok: true,
    value: {
      name: name.value,
      instructions: instructions.value,
      modelConnectionId: modelConnectionId.value,
      model: model.value,
      runtimeProfileId: runtimeProfileId.value,
      permissions: permissions.value,
    },
  };
}

/**
 * `PATCH /api/agents/:id` — every field is optional, but an absent field and a field explicitly
 * set to `undefined` are not the same thing.
 *
 * `{"name": undefined}` cannot survive `JSON.parse` (JSON has no `undefined`), so in practice the
 * `undefined`-under-a-present-key case arrives only from an in-process caller. It is rejected by
 * name rather than treated as "absent", because "the client sent a field whose value we could not
 * represent" and "the client sent no field" are different client bugs and only one of them is
 * harmless.
 *
 * A body with no recognised field is rejected too. Accepting it would mean a `200` for a request
 * that changed nothing, which reads to a client as a successful update.
 */
export function parseUpdateAgentPatch(raw: unknown): ParseResult<UpdateAgentPatch> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [`the request body must be a JSON object; received ${describe(raw)}.`],
    };
  }
  const errors: string[] = [...unknownKeyErrors(raw)];
  const patch: { -readonly [K in keyof UpdateAgentPatch]: UpdateAgentPatch[K] } = {};
  let present = 0;

  for (const field of AGENT_MUTABLE_FIELDS) {
    if (!hasKey(raw, field)) continue;
    present += 1;
    const value = raw[field];
    if (value === undefined) {
      errors.push(
        `${field} was sent with no value; omit the key instead of setting it to undefined.`,
      );
      continue;
    }
    switch (field) {
      case 'name': {
        const parsed = parseAgentName(value);
        if (parsed.ok) patch.name = parsed.value;
        else errors.push(...parsed.errors);
        break;
      }
      case 'instructions': {
        const parsed = parseAgentInstructions(value);
        if (parsed.ok) patch.instructions = parsed.value;
        else errors.push(...parsed.errors);
        break;
      }
      case 'modelConnectionId': {
        const parsed = parseModelConnectionId(value);
        if (parsed.ok) patch.modelConnectionId = parsed.value;
        else errors.push(...parsed.errors);
        break;
      }
      case 'model': {
        const parsed = parseAgentModel(value);
        if (parsed.ok) patch.model = parsed.value;
        else errors.push(...parsed.errors);
        break;
      }
      case 'runtimeProfileId': {
        const parsed = parseRuntimeProfileId(value);
        if (parsed.ok) patch.runtimeProfileId = parsed.value;
        else errors.push(...parsed.errors);
        break;
      }
      case 'permissions': {
        const parsed = parseAgentPermissions(value);
        if (parsed.ok) patch.permissions = parsed.value;
        else errors.push(...parsed.errors);
        break;
      }
      default: {
        // Total by construction: `field` is narrowed to `never` here, so adding a member to
        // AGENT_MUTABLE_FIELDS without adding a case is a compile error, not a silently ignored
        // field (ADR-0015 — every classifier ends in an explicit else that rejects).
        const unreachable: never = field;
        errors.push(`${String(unreachable)} has no parser.`);
        break;
      }
    }
  }

  if (present === 0) {
    errors.push(
      `the request body changed nothing; supply at least one of ${AGENT_MUTABLE_FIELDS.join(', ')}.`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: patch };
}

/** Serialise a stored agent for the wire. The only transformation is `Date` → ISO-8601. */
export function toAgentResource(agent: AgentRecord): AgentResource {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    instructions: agent.instructions,
    modelConnectionId: agent.modelConnectionId,
    model: agent.model,
    runtimeProfileId: agent.runtimeProfileId,
    permissions: { ...agent.permissions },
    createdBy: agent.createdBy,
    ownerPrincipalId: agent.ownerPrincipalId,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}
