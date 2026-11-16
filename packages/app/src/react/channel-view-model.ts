/**
 * The pure half of `ChannelView` (issue #1519): what a channel's events say the messages are,
 * how they group into threads, who is here, and who a message mentions. No React and no
 * `fetch`, so every rule is tested on plain values.
 *
 * - {@link mergeChannelEvents}: the events of a resource bound to a channel (`created`,
 *   `updated`, `deleted`, each with the record as `data`), folded by record id: an update
 *   replaces, a delete removes, and an event delivered twice is applied once.
 * - {@link threadsOf}: messages grouped on a `ref()` to their own resource (`thread_root`).
 * - {@link recordPresence} and {@link presentPrincipals}: `presence` heartbeats, every 15 s,
 *   forgotten 45 s after a person's last one.
 * - {@link mentionsOf}, {@link mentionQuery} and {@link withMention}: `@Name` over the members.
 */
import { PRESENCE_EXPIRY_MS } from '../channel-wire.js';
import type { FieldDefinition } from '../fields/types.js';
import { blocksToMarkdown, markdownToBlocks } from '../pages/blocks.js';
import type { RichTextBlock } from '../fields/rich-text.js';
import type { DefinedResource, FieldMap } from '../resource.js';

/** One event of a channel, as `useChannel` holds it. */
export interface ChannelViewEvent {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
}

/** A record a channel carries: its id, when it was made, and its fields. */
export type ChannelRecord = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly created_at: string;
};

/** Someone a message can mention and the presence row can name: a person or an agent. */
export interface ChannelMember {
  readonly principalId: string;
  readonly name: string;
}

function isRecord(value: unknown): value is ChannelRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['created_at'] === 'string';
}

/** Oldest first; equal times by id, so every reader sees one order. */
function oldestFirst(a: ChannelRecord, b: ChannelRecord): number {
  const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The records `events` leave, oldest first. Events are applied in the order given, each event id
 * once; an event whose `data` is not a record, or whose type is none of the three, is ignored.
 */
export function mergeChannelEvents(events: readonly ChannelViewEvent[]): readonly ChannelRecord[] {
  const applied = new Set<string>();
  const records = new Map<string, ChannelRecord>();
  for (const event of events) {
    if (applied.has(event.id)) continue;
    applied.add(event.id);
    if (!isRecord(event.data)) continue;
    if (event.type === 'created' || event.type === 'updated') {
      records.set(event.data.id, event.data);
    } else if (event.type === 'deleted') {
      records.delete(event.data.id);
    }
  }
  return [...records.values()].sort(oldestFirst);
}

/** A thread: its first message and the replies to it, oldest first. */
export interface ChannelThread {
  readonly root: ChannelRecord;
  readonly replies: readonly ChannelRecord[];
}

/**
 * `records` grouped into threads on `threadField`: a record whose `threadField` names another
 * record of the list is a reply to it; any other record (no root, or a root no longer here)
 * starts a thread. Without a `threadField`, every record is its own thread.
 */
export function threadsOf(
  records: readonly ChannelRecord[],
  threadField: string | undefined,
): readonly ChannelThread[] {
  const ids = new Set(records.map((record) => record.id));
  const rootOf = (record: ChannelRecord): string | undefined => {
    if (threadField === undefined) return undefined;
    const root = record[threadField];
    return typeof root === 'string' && root !== record.id && ids.has(root) ? root : undefined;
  };
  const replies = new Map<string, ChannelRecord[]>();
  const roots: ChannelRecord[] = [];
  for (const record of records) {
    const root = rootOf(record);
    if (root === undefined) {
      roots.push(record);
    } else {
      replies.set(root, [...(replies.get(root) ?? []), record]);
    }
  }
  return roots.map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
}

/** When each person was last heard from, in epoch milliseconds. */
export type PresenceState = ReadonlyMap<string, number>;

/** `state` with `principalId` heard from at `at`; an older heartbeat changes nothing. */
export function recordPresence(
  state: PresenceState,
  principalId: string,
  at: number,
): PresenceState {
  if ((state.get(principalId) ?? Number.NEGATIVE_INFINITY) >= at) return state;
  return new Map([...state, [principalId, at]]);
}

/** The people heard from within the last 45 s at `now`, in the order they were first heard. */
export function presentPrincipals(state: PresenceState, now: number): readonly string[] {
  return [...state]
    .filter(([, at]) => now - at < PRESENCE_EXPIRY_MS)
    .map(([principalId]) => principalId);
}

/** A member's name, or a short form of the principal id when the members list lacks them. */
export function memberName(members: readonly ChannelMember[], principalId: string): string {
  return (
    members.find((member) => member.principalId === principalId)?.name ?? principalId.slice(0, 8)
  );
}

const MENTION_END = /^(?:$|[\s.,!?;:)\]}、。！？])/u;

/**
 * The principal ids `text` mentions, each once, in the order first mentioned: `@` and a member's
 * name, followed by the end, a space or punctuation. The longest name wins, so `@Ann Lee` is Ann
 * Lee, not Ann; names compare without case.
 */
export function mentionsOf(text: string, members: readonly ChannelMember[]): readonly string[] {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    const after = lower.slice(at + 1);
    const member = byLength.find(
      (candidate) =>
        candidate.name !== '' &&
        after.startsWith(candidate.name.toLowerCase()) &&
        MENTION_END.test(after.slice(candidate.name.length)),
    );
    if (member !== undefined && !found.includes(member.principalId)) {
      found.push(member.principalId);
    }
  }
  return found;
}

/** The `@partial` being typed at the end of `text`, or `null` when there is none. */
export function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]{0,40})$/u.exec(text);
  return match === null ? null : (match[1] ?? '');
}

/** The members whose name starts with what `@` is followed by at the end of `text`. */
export function mentionSuggestions(
  text: string,
  members: readonly ChannelMember[],
): readonly ChannelMember[] {
  const query = mentionQuery(text);
  if (query === null) return [];
  const lower = query.toLowerCase();
  return members.filter((member) => member.name.toLowerCase().startsWith(lower)).slice(0, 8);
}

/** `text` with the `@partial` at its end replaced by `@<member's name> `. */
export function withMention(text: string, member: ChannelMember): string {
  const query = mentionQuery(text);
  const base = query === null ? text : text.slice(0, text.length - query.length - 1);
  return `${base}@${member.name} `;
}

/** The fields a `ChannelView` reads and writes, found on the resource unless the page names them. */
export interface ChannelFields {
  /** The `ref()` field whose value is the channel key. */
  readonly keyField: string;
  /** The `text()` or `richText()` field a message's body is. */
  readonly bodyField: string;
  readonly bodyIsRichText: boolean;
  /** The `ref()` to the resource itself that a reply names its thread's first message in. */
  readonly threadField: string | undefined;
  /** The `files()` field a message's attachments are. */
  readonly attachmentsField: string | undefined;
}

/** What {@link channelFieldsOf} may be told instead of finding it. */
export interface ChannelFieldChoices {
  readonly keyField?: string;
  readonly bodyField?: string;
  readonly threadField?: string;
}

function firstField(
  fields: FieldMap,
  test: (field: FieldDefinition, name: string) => boolean,
): string | undefined {
  return Object.entries(fields).find(([name, field]) => test(field, name))?.[0];
}

/**
 * The fields of `resource` a channel view uses: the key is the first `ref()` to another
 * resource, the body the first `text()` or `richText()`, the thread the first `ref()` to the
 * resource itself, the attachments the first `files()`.
 *
 * @throws {TypeError} when there is no key or body field, or a named one is not of the resource.
 */
export function channelFieldsOf(
  resource: DefinedResource,
  choices: ChannelFieldChoices = {},
): ChannelFields {
  const { fields } = resource;
  const isRef = (field: FieldDefinition): boolean => field.type === 'ref';
  const target = (field: FieldDefinition): unknown => field.options['resource'];
  const keyField =
    choices.keyField ??
    firstField(fields, (field) => isRef(field) && target(field) !== resource.name);
  const bodyField =
    choices.bodyField ??
    firstField(fields, (field) => field.type === 'text' || field.type === 'richText');
  const threadField =
    choices.threadField ??
    firstField(fields, (field) => isRef(field) && target(field) === resource.name);
  for (const [what, name] of [
    ['key', keyField],
    ['body', bodyField],
    ['thread', threadField],
  ] as const) {
    if (what === 'thread' && name === undefined) continue;
    if (name === undefined || fields[name] === undefined) {
      throw new TypeError(
        `ChannelView: ${resource.name} has no ${what} field ${name ?? ''}`.trim(),
      );
    }
  }
  return {
    keyField: keyField ?? '',
    bodyField: bodyField ?? '',
    bodyIsRichText: fields[bodyField ?? '']?.type === 'richText',
    threadField,
    attachmentsField: firstField(fields, (field) => field.type === 'files'),
  };
}

/** A message body as Markdown: a `text()` value as it is, a `richText()` one from its blocks. */
export function bodyTextOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return blocksToMarkdown(value as readonly RichTextBlock[]);
  return '';
}

/** What the composer sends. */
export interface ComposedMessage {
  readonly text: string;
  readonly keyValue: string;
  /** The thread's first message, for a reply. */
  readonly threadRoot?: string | undefined;
  readonly attachments?: readonly string[];
}

/** The body of the `create` a composed message becomes, or `null` when there is nothing to send. */
export function messageInput(
  fields: ChannelFields,
  message: ComposedMessage,
): Readonly<Record<string, unknown>> | null {
  const text = message.text.trim();
  const attachments = message.attachments ?? [];
  if (text === '' && attachments.length === 0) return null;
  return {
    [fields.keyField]: message.keyValue,
    [fields.bodyField]: fields.bodyIsRichText ? markdownToBlocks(text) : text,
    ...(fields.threadField === undefined || message.threadRoot === undefined
      ? {}
      : { [fields.threadField]: message.threadRoot }),
    ...(fields.attachmentsField === undefined || attachments.length === 0
      ? {}
      : { [fields.attachmentsField]: [...attachments] }),
  };
}
