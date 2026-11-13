/**
 * The body of `POST /api/agents/:id/runs`, judged field by field by {@link parseStartRunBody}.
 * `api.ts` re-exports it, so `runs/api` stays the one public import path.
 */
import { AGENT_VERSION_NUMBER_MAX } from '@indx-workspace/contracts/agent-versions';
import { IDENTITY_SUBJECT_MAX_LENGTH } from '@indx-workspace/contracts/identity-assertion';
import {
  isCanonicalFileScopePath,
  MAX_RUN_ATTACHMENTS,
  MAX_RUN_FILE_SCOPE_PATHS,
  outputSchemaViolation,
  SpendCeilingUsdSchema,
} from '@indx-workspace/contracts/runs';

import { isUuid } from './http';
import { MAX_PROMPT_CHARS, type StartRunBody } from './service';

export type StartRunBodyVerdict =
  | { readonly kind: 'ok'; readonly body: StartRunBody }
  | { readonly kind: 'rejected'; readonly reason: string };

type Rejected = { readonly kind: 'rejected'; readonly reason: string };

const START_RUN_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'sessionId',
  'modelConnectionId',
  'model',
  'version',
  'attachments',
  'outputSchema',
  'subject',
  'fileScope',
  'spendCeilingUsd',
]);

type AttachmentsParse =
  | { readonly kind: 'ok'; readonly attachments: StartRunBody['attachments'] }
  | { readonly kind: 'rejected'; readonly reason: string };

/** The same rules as `StartRunRequestSchema.attachments`: 1 to 10 strict `{ fileId }`, no repeats. */
function parseAttachments(raw: unknown): AttachmentsParse {
  if (raw === undefined) return { kind: 'ok', attachments: undefined };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RUN_ATTACHMENTS) {
    return {
      kind: 'rejected',
      reason: `"attachments" must be an array of 1 to ${String(MAX_RUN_ATTACHMENTS)} items when it is present`,
    };
  }
  const seen = new Set<string>();
  const attachments: { readonly fileId: string }[] = [];
  for (const item of raw as unknown[]) {
    const fileId =
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? (item as Record<string, unknown>)['fileId']
        : undefined;
    if (
      typeof fileId !== 'string' ||
      fileId.length === 0 ||
      Object.keys(item as object).length !== 1
    ) {
      return {
        kind: 'rejected',
        reason: 'each "attachments" item must be an object with only a non-empty "fileId"',
      };
    }
    if (seen.has(fileId)) {
      return { kind: 'rejected', reason: '"attachments" must not name the same "fileId" twice' };
    }
    seen.add(fileId);
    attachments.push({ fileId });
  }
  return { kind: 'ok', attachments };
}

function parseOutputSchema(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly schema: Readonly<Record<string, unknown>> | undefined }
  | { readonly kind: 'rejected'; readonly reason: string } {
  if (raw === undefined) return { kind: 'ok', schema: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'rejected', reason: '"outputSchema" must be a JSON Schema object' };
  }
  const violation = outputSchemaViolation(raw);
  if (violation !== null) {
    return { kind: 'rejected', reason: `"outputSchema" is not accepted: ${violation.message}` };
  }
  return { kind: 'ok', schema: raw as Readonly<Record<string, unknown>> };
}

function parseSubject(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly field: { readonly subject?: string } }
  | { readonly kind: 'rejected'; readonly reason: string } {
  if (raw === undefined) return { kind: 'ok', field: {} };
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= IDENTITY_SUBJECT_MAX_LENGTH) {
    return { kind: 'ok', field: { subject: raw } };
  }
  return {
    kind: 'rejected',
    reason: `"subject" must be a string of 1 to ${String(IDENTITY_SUBJECT_MAX_LENGTH)} characters when it is present`,
  };
}

/** The same rules as `StartRunRequestSchema.fileScope`: 1 to 100 canonical paths, no repeats. */
function parseFileScope(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly field: { readonly fileScope?: readonly string[] } }
  | { readonly kind: 'rejected'; readonly reason: string } {
  if (raw === undefined) return { kind: 'ok', field: {} };
  if (
    Array.isArray(raw) &&
    raw.length >= 1 &&
    raw.length <= MAX_RUN_FILE_SCOPE_PATHS &&
    (raw as unknown[]).every(
      (path) => typeof path === 'string' && isCanonicalFileScopePath(path),
    ) &&
    new Set(raw as string[]).size === raw.length
  ) {
    return { kind: 'ok', field: { fileScope: raw as string[] } };
  }
  return {
    kind: 'rejected',
    reason: `"fileScope" must be an array of 1 to ${String(MAX_RUN_FILE_SCOPE_PATHS)} distinct canonical workspace-relative paths when it is present`,
  };
}

/** `StartRunRequestSchema.spendCeilingUsd` (ADR-0162), judged by the contract's own schema. */
function parseSpendCeiling(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly field: { readonly spendCeilingUsd?: number } }
  | { readonly kind: 'rejected'; readonly reason: string } {
  if (raw === undefined) return { kind: 'ok', field: {} };
  const parsed = SpendCeilingUsdSchema.safeParse(raw);
  return parsed.success
    ? { kind: 'ok', field: { spendCeilingUsd: parsed.data } }
    : {
        kind: 'rejected',
        reason:
          '"spendCeilingUsd" must be a positive number of USD, at most 1000000 and with at most six decimal places, when it is present',
      };
}

/** The start-run keys this server refuses, or `null` when every key is one it honours. */
function refuseStartRunKeys(record: Record<string, unknown>): StartRunBodyVerdict | null {
  const unknown = Object.keys(record).find((key) => !START_RUN_KEYS.has(key));
  return unknown === undefined
    ? null
    : { kind: 'rejected', reason: `unknown field ${JSON.stringify(unknown)} in the request body` };
}

/** The required `prompt`: a non-blank string of at most `MAX_PROMPT_CHARS` characters. */
function parsePrompt(raw: unknown): { readonly kind: 'ok'; readonly prompt: string } | Rejected {
  if (typeof raw !== 'string') {
    return { kind: 'rejected', reason: '"prompt" is required and must be a string' };
  }
  if (raw.trim().length === 0) {
    return { kind: 'rejected', reason: '"prompt" must not be empty' };
  }
  if (raw.length > MAX_PROMPT_CHARS) {
    return {
      kind: 'rejected',
      reason: `"prompt" is ${String(raw.length)} characters; the maximum is ${String(MAX_PROMPT_CHARS)}`,
    };
  }
  return { kind: 'ok', prompt: raw };
}

/** The optional `modelConnectionId` and `model`, which name a run's model override together. */
function parseModelOverride(
  record: Record<string, unknown>,
): { readonly kind: 'ok'; readonly modelOverride: StartRunBody['modelOverride'] } | Rejected {
  const rawConnection = record['modelConnectionId'];
  if (rawConnection !== undefined && rawConnection !== null && !isUuid(rawConnection)) {
    return {
      kind: 'rejected',
      reason: '"modelConnectionId" must be a UUID when it is present',
    };
  }
  const rawModel = record['model'];
  if (
    rawModel !== undefined &&
    rawModel !== null &&
    (typeof rawModel !== 'string' || rawModel.length === 0)
  ) {
    return { kind: 'rejected', reason: '"model" must be a non-empty string when it is present' };
  }
  const connectionId = rawConnection ?? null;
  const model = rawModel ?? null;
  // #129: written and cleared as one pair, never one without the other — matching every other
  // configurable layer of the resolution ladder.
  if ((connectionId === null) !== (model === null)) {
    return {
      kind: 'rejected',
      reason: '"modelConnectionId" and "model" must be supplied together, or not at all',
    };
  }
  return {
    kind: 'ok',
    modelOverride: connectionId === null || model === null ? null : { connectionId, model },
  };
}

type RunOptionFields = Pick<
  StartRunBody,
  'version' | 'outputSchema' | 'attachments' | 'subject' | 'fileScope' | 'spendCeilingUsd'
>;

/**
 * The optional `sessionId` and the per-run fields that go with it: a new session takes every
 * option, and a follow-up in an existing session refuses `version`, which only a new session pins.
 */
function sessionFields(
  rawSession: unknown,
  fields: RunOptionFields,
):
  | {
      readonly kind: 'ok';
      readonly sessionId: string | null;
      readonly fields: RunOptionFields;
    }
  | Rejected {
  const { version, ...perRun } = fields;
  if (rawSession === undefined || rawSession === null) {
    return { kind: 'ok', sessionId: null, fields };
  }
  if (!isUuid(rawSession)) {
    return { kind: 'rejected', reason: '"sessionId" must be a UUID when it is present' };
  }
  if (version !== undefined) {
    return {
      kind: 'rejected',
      reason: '"version" applies to a new session: omit "sessionId"',
    };
  }
  return { kind: 'ok', sessionId: rawSession, fields: perRun };
}

/**
 * Parse the start-run body. **Never throws**, and never returns `ok` for a shape it did not
 * positively recognise — an unknown key is rejected rather than ignored, for the reason
 * `packages/run-protocol/src/schemas.ts` already gives about `.strict()`: a setting the server does not
 * know how to honour, accepted silently, is a request the caller believes was obeyed.
 */
export function parseStartRunBody(input: unknown): StartRunBodyVerdict {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { kind: 'rejected', reason: 'the request body must be a JSON object' };
  }
  const record = input as Record<string, unknown>;
  const keyRefusal = refuseStartRunKeys(record);
  if (keyRefusal !== null) return keyRefusal;
  const prompt = parsePrompt(record['prompt']);
  if (prompt.kind === 'rejected') return prompt;
  const override = parseModelOverride(record);
  if (override.kind === 'rejected') return override;
  const options = parseRunOptions(record);
  if (options.kind === 'rejected') return options;
  const session = sessionFields(record['sessionId'], options.fields);
  if (session.kind === 'rejected') return session;
  return {
    kind: 'ok',
    body: {
      prompt: prompt.prompt,
      sessionId: session.sessionId,
      modelOverride: override.modelOverride,
      ...session.fields,
    },
  };
}

/** The optional `version`, `outputSchema`, `attachments`, `subject`, `fileScope` and `spendCeilingUsd` of a start-run body, each checked. */
function parseRunOptions(
  record: Record<string, unknown>,
): { readonly kind: 'ok'; readonly fields: RunOptionFields } | Rejected {
  const rawVersion = record['version'];
  if (
    rawVersion !== undefined &&
    (typeof rawVersion !== 'number' ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 1 ||
      rawVersion > AGENT_VERSION_NUMBER_MAX)
  ) {
    return { kind: 'rejected', reason: '"version" must be a positive integer when it is present' };
  }
  const attached = parseAttachments(record['attachments']);
  if (attached.kind === 'rejected') return attached;
  const parsedSchema = parseOutputSchema(record['outputSchema']);
  if (parsedSchema.kind === 'rejected') return parsedSchema;
  const parsedSubject = parseSubject(record['subject']);
  if (parsedSubject.kind === 'rejected') return parsedSubject;
  const parsedScope = parseFileScope(record['fileScope']);
  if (parsedScope.kind === 'rejected') return parsedScope;
  const parsedCeiling = parseSpendCeiling(record['spendCeilingUsd']);
  if (parsedCeiling.kind === 'rejected') return parsedCeiling;
  return {
    kind: 'ok',
    fields: {
      ...(rawVersion === undefined ? {} : { version: rawVersion }),
      ...(parsedSchema.schema === undefined ? {} : { outputSchema: parsedSchema.schema }),
      ...(attached.attachments === undefined ? {} : { attachments: attached.attachments }),
      ...parsedSubject.field,
      ...parsedScope.field,
      ...parsedCeiling.field,
    },
  };
}
