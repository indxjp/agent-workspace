'use client';
/**
 * `ChannelView` (issue #1519): the channel screen of a team-chat app, one key of a resource bound
 * to a `channel()` (`aw generate channel <resource>`):
 *
 * - the message list, live from the channel's stream (`useChannel`), with `aria-live="polite"`;
 *   an update replaces a message, a delete removes it, an event delivered twice is applied once;
 * - a thread pane on the resource's `ref()` to itself (`thread_root`);
 * - a composer that creates through the resource's own routes (`resourceClient`), with `@`
 *   mentions over `members` and, given `uploadFile`, `files()` attachments;
 * - a presence row: the people whose stream is open, from the channel's `presence` heartbeats
 *   every 15 s, each forgotten 45 s after their last.
 *
 * A message body renders as Markdown without raw HTML (`AssistantProse`, ADR-0141); a `richText()`
 * body through its blocks' Markdown. Every string is the locale's, `ja` or `en`.
 *
 * shortcut: the list is what the channel's stream replays, its newest `retain` events (1000 by
 * default), not the resource's paged list, because a list cannot yet filter on a `ref()` field;
 * upgrade when `ResourceStore.list` takes a `ref()` filter, and page older messages in from it.
 */
import { AssistantProse, AttachmentChips, prepareAttachment } from '@indx-workspace/react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import { ChannelPresenceSchema, PRESENCE_EVENT } from '../channel-wire.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import type { ChannelEphemeral, ChannelStatus } from './channel-follow.js';
import {
  bodyTextOf,
  channelFieldsOf,
  memberName,
  mentionSuggestions,
  mergeChannelEvents,
  messageInput,
  presentPrincipals,
  recordPresence,
  threadsOf,
  withMention,
  type ChannelFields,
  type ChannelMember,
  type ChannelRecord,
  type ChannelThread,
  type PresenceState,
} from './channel-view-model.js';
import { resourceClient, ResourceProblemError, type ResourceClient } from './client.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, problemMessage, type AppLocale, type ChannelStrings } from './locale.js';
import { useChannel, type UseChannelOptions } from './use-channel.js';

/** How often the presence row looks again for someone to forget. */
const PRESENCE_TICK_MS = 5_000;

/** A file the composer attached: its platform file id and its name. */
export interface ChannelAttachment {
  readonly id: string;
  readonly name: string;
}

/** The props of {@link ChannelView}. */
export interface ChannelViewProps<F extends FieldMap = FieldMap> {
  /** The channel's name, as `channel('<name>', …)` defines it and its events route serves it. */
  readonly channel: string;
  /** The resource whose writes the channel publishes: the messages. */
  readonly resource: DefinedResource<F>;
  /** The key: the record id the messages' key field names (the channel, the room). */
  readonly keyValue: string;
  /** The `ref()` field to the resource itself replies name their thread in; found when not given. */
  readonly threadField?: string | undefined;
  /** The `ref()` field the key is in; the first `ref()` to another resource when not given. */
  readonly keyField?: string | undefined;
  /** The `text()` or `richText()` field of the body; the first one when not given. */
  readonly bodyField?: string | undefined;
  /** Who can be mentioned and whose names the list shows: the channel's people and agents. */
  readonly members?: readonly ChannelMember[] | undefined;
  /**
   * Uploads one file and gives back its platform file id, such as through the SDK's
   * `client.files`; without it, the composer offers no attachments.
   */
  readonly uploadFile?: ((file: File) => Promise<ChannelAttachment>) | undefined;
  readonly locale?: AppLocale | undefined;
  /** The resource's routes; `resourceClient(resource)` on the page's own origin when not given. */
  readonly client?: ResourceClient<F> | undefined;
  /** How the stream is reached; the page's own origin when not given. */
  readonly channelOptions?: Omit<UseChannelOptions, 'onEphemeral'> | undefined;
  /** The clock of presence; `Date.now` when not given. */
  readonly now?: (() => number) | undefined;
}

/** What one message is drawn with. */
interface MessageContext {
  readonly fields: ChannelFields;
  readonly members: readonly ChannelMember[];
  readonly strings: ChannelStrings;
  readonly locale: AppLocale;
}

function timeOf(at: string, locale: AppLocale): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString(locale === 'ja' ? 'ja-JP' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fileIdsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** One message: who wrote it and when, its body and its attachments. */
export function ChannelMessage({
  record,
  context,
  children,
}: {
  readonly record: ChannelRecord;
  readonly context: MessageContext;
  readonly children?: ReactNode;
}): ReactNode {
  const { fields, members, locale } = context;
  const author = typeof record['created_by'] === 'string' ? record['created_by'] : '';
  const attachments =
    fields.attachmentsField === undefined ? [] : fileIdsOf(record[fields.attachmentsField]);
  return (
    <article className="aw-app-channel-message">
      <p className="aw-app-channel-byline">
        <strong>{memberName(members, author)}</strong>{' '}
        <time dateTime={record.created_at}>{timeOf(record.created_at, locale)}</time>
      </p>
      <AssistantProse text={bodyTextOf(record[fields.bodyField])} className="aw-app-channel-body" />
      {attachments.length === 0 ? null : (
        <span className="aw-app-attachments">
          <AttachmentChips
            items={attachments.map((id) => ({ id, name: id.slice(0, 8) }))}
            classNames={{ chip: 'aw-app-chip' }}
          />
        </span>
      )}
      {children}
    </article>
  );
}

/** The message list: each thread's first message, with the button that opens its thread. */
export function ChannelMessageList({
  threads,
  context,
  onOpenThread,
}: {
  readonly threads: readonly ChannelThread[];
  readonly context: MessageContext;
  readonly onOpenThread?: ((rootId: string) => void) | undefined;
}): ReactNode {
  const { strings, fields } = context;
  return (
    <ol className="aw-app-channel-list" aria-label={strings.messagesLabel} aria-live="polite">
      {threads.length === 0 ? <li className="aw-app-empty">{strings.noMessages}</li> : null}
      {threads.map((thread) => (
        <li key={thread.root.id}>
          <ChannelMessage record={thread.root} context={context}>
            {fields.threadField === undefined || onOpenThread === undefined ? null : (
              <button
                type="button"
                className="aw-app-button aw-app-channel-thread-button"
                onClick={() => onOpenThread(thread.root.id)}
              >
                {strings.openThread(thread.replies.length)}
              </button>
            )}
          </ChannelMessage>
        </li>
      ))}
    </ol>
  );
}

/** The mention suggestions for the `@partial` at the end of the composer's text. */
export function MentionSuggestions({
  text,
  members,
  strings,
  onPick,
}: {
  readonly text: string;
  readonly members: readonly ChannelMember[];
  readonly strings: ChannelStrings;
  readonly onPick: (member: ChannelMember) => void;
}): ReactNode {
  const suggestions = mentionSuggestions(text, members);
  if (suggestions.length === 0) return null;
  return (
    <ul className="aw-app-channel-mentions" aria-label={strings.mentionsLabel}>
      {suggestions.map((member) => (
        <li key={member.principalId}>
          <button
            type="button"
            className="aw-app-button"
            aria-label={strings.mentionLabel(member.name)}
            onClick={() => onPick(member)}
          >
            @{member.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The presence row: who is here now. */
export function PresenceRow({
  present,
  members,
  strings,
}: {
  readonly present: readonly string[];
  readonly members: readonly ChannelMember[];
  readonly strings: ChannelStrings;
}): ReactNode {
  return (
    <p className="aw-app-channel-presence" role="status">
      <span className="aw-app-label">{strings.presenceLabel}: </span>
      {present.length === 0
        ? strings.nobodyHere
        : present.map((principalId) => memberName(members, principalId)).join(', ')}
    </p>
  );
}

/** What the composer sends with, and how. */
interface ComposerProps {
  readonly label: string;
  readonly fields: ChannelFields;
  readonly keyValue: string;
  readonly threadRoot?: string | undefined;
  readonly members: readonly ChannelMember[];
  readonly strings: ChannelStrings;
  readonly problemText: (code: string) => string;
  /** The accessible name of an attachment's remove button. */
  readonly removeFile: (name: string) => string;
  readonly create: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly uploadFile?: ((file: File) => Promise<ChannelAttachment>) | undefined;
}

type SendState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'failed'; readonly message: string };

/** The composer: a text area with `@` mentions, attachments, and the send button. */
export function ChannelComposer(props: ComposerProps): ReactNode {
  const { fields, strings, members, uploadFile } = props;
  const id = useId();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<readonly ChannelAttachment[]>([]);
  const [send, setSend] = useState<SendState>({ kind: 'idle' });
  const [upload, setUpload] = useState<'idle' | 'uploading' | 'failed'>('idle');
  const sending = send.kind === 'sending';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const input = messageInput(fields, {
      text,
      keyValue: props.keyValue,
      threadRoot: props.threadRoot,
      attachments: attachments.map((file) => file.id),
    });
    if (input === null || sending) return;
    setSend({ kind: 'sending' });
    props.create(input).then(
      () => {
        setText('');
        setAttachments([]);
        setSend({ kind: 'idle' });
      },
      (error: unknown) => {
        const code = error instanceof ResourceProblemError ? error.code : 'other';
        setSend({ kind: 'failed', message: props.problemText(code) });
      },
    );
  };

  const attach = (file: File): void => {
    if (uploadFile === undefined) return;
    setUpload('uploading');
    prepareAttachment(file)
      .then(uploadFile)
      .then(
        (uploaded) => {
          setAttachments((current) => [...current, uploaded]);
          setUpload('idle');
        },
        () => setUpload('failed'),
      );
  };

  return (
    <form className="aw-app-channel-composer" onSubmit={submit}>
      <label htmlFor={`${id}-text`} className="aw-app-label">
        {props.label}
      </label>
      <textarea
        id={`${id}-text`}
        rows={3}
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
      />
      <MentionSuggestions
        text={text}
        members={members}
        strings={strings}
        onPick={(member) => setText((current) => withMention(current, member))}
      />
      {fields.attachmentsField === undefined || uploadFile === undefined ? null : (
        <div className="aw-app-channel-attach">
          <label htmlFor={`${id}-file`} className="aw-app-label">
            {strings.attach}
          </label>
          <input
            id={`${id}-file`}
            type="file"
            disabled={sending || upload === 'uploading'}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) attach(file);
            }}
          />
          {upload === 'idle' ? null : (
            <p role="status">{upload === 'uploading' ? strings.uploading : strings.uploadFailed}</p>
          )}
          <span className="aw-app-attachments">
            <AttachmentChips
              items={attachments}
              removeLabel={props.removeFile}
              onRemove={(removed) =>
                setAttachments((current) => current.filter((file) => file.id !== removed))
              }
              disabled={sending}
              classNames={{ chip: 'aw-app-chip', remove: 'aw-app-chip-remove' }}
            />
          </span>
        </div>
      )}
      {send.kind === 'failed' ? (
        <div className="aw-app-alert" role="alert">
          <p className="aw-app-alert-heading">{strings.sendFailed}</p>
          <p>{send.message}</p>
        </div>
      ) : null}
      <button type="submit" className="aw-app-button" disabled={sending}>
        {sending ? strings.sending : strings.send}
      </button>
    </form>
  );
}

function statusLine(status: ChannelStatus, strings: ChannelStrings): string | null {
  switch (status) {
    case 'connecting':
      return strings.connecting;
    case 'reconnecting':
      return strings.reconnecting;
    case 'lost':
      return strings.lost;
    default:
      return null;
  }
}

/** The presence of the channel's key, kept from its heartbeats and redrawn as people expire. */
function usePresence(now: () => number): {
  readonly present: readonly string[];
  readonly onEphemeral: (event: ChannelEphemeral) => void;
} {
  const [state, setState] = useState<PresenceState>(() => new Map());
  const [tick, setTick] = useState(() => now());
  useEffect(() => {
    const timer = setInterval(() => setTick(now()), PRESENCE_TICK_MS);
    return () => clearInterval(timer);
  }, [now]);
  const onEphemeral = useCallback(
    (event: ChannelEphemeral) => {
      if (event.type !== PRESENCE_EVENT) return;
      const presence = ChannelPresenceSchema.safeParse(event.data);
      if (!presence.success) return;
      const at = now();
      setState((current) => recordPresence(current, presence.data.principalId, at));
      setTick(at);
    },
    [now],
  );
  return { present: presentPrincipals(state, tick), onEphemeral };
}

/** One key of a resource's channel: its messages, a thread, the composer and who is here. */
export function ChannelView<F extends FieldMap>(props: ChannelViewProps<F>): ReactNode {
  const { resource, keyValue } = props;
  const locale = useAppLocale(props.locale);
  const allStrings = appStrings(locale);
  const strings = allStrings.channel;
  const members = props.members ?? [];
  const now = props.now ?? Date.now;
  const fields = useMemo(
    () =>
      channelFieldsOf(resource as unknown as DefinedResource, {
        ...(props.keyField === undefined ? {} : { keyField: props.keyField }),
        ...(props.bodyField === undefined ? {} : { bodyField: props.bodyField }),
        ...(props.threadField === undefined ? {} : { threadField: props.threadField }),
      }),
    [resource, props.keyField, props.bodyField, props.threadField],
  );
  const client = useMemo(
    () => (props.client ?? resourceClient(resource)) as unknown as ResourceClient,
    [props.client, resource],
  );
  const { present, onEphemeral } = usePresence(now);
  const channel = useChannel(props.channel, keyValue, {
    ...props.channelOptions,
    onEphemeral,
  });
  const threads = useMemo(
    () => threadsOf(mergeChannelEvents(channel.events), fields.threadField),
    [channel.events, fields.threadField],
  );
  const [openRoot, setOpenRoot] = useState<string | null>(null);
  const open = threads.find((thread) => thread.root.id === openRoot);
  const context: MessageContext = { fields, members, strings, locale };
  const composer = {
    fields,
    keyValue,
    members,
    strings,
    problemText: (code: string) => problemMessage(allStrings, code),
    removeFile: allStrings.removeFile,
    create: (input: Readonly<Record<string, unknown>>) => client.create(input),
    uploadFile: props.uploadFile,
  };
  const line =
    channel.status === 'refused' && channel.problem !== null
      ? problemMessage(allStrings, channel.problem.code)
      : statusLine(channel.status, strings);

  return (
    <section className="aw-app-channel" aria-label={strings.channelLabel}>
      <PresenceRow present={present} members={members} strings={strings} />
      {line === null ? null : (
        <p className="aw-app-channel-status" role="status">
          {line}
        </p>
      )}
      <div className="aw-app-channel-panes">
        <div className="aw-app-channel-main">
          <ChannelMessageList threads={threads} context={context} onOpenThread={setOpenRoot} />
          <ChannelComposer {...composer} label={strings.composerLabel} />
        </div>
        {open === undefined ? null : (
          <aside className="aw-app-channel-thread" aria-label={strings.threadLabel}>
            <button type="button" className="aw-app-button" onClick={() => setOpenRoot(null)}>
              {strings.closeThread}
            </button>
            <ChannelMessage record={open.root} context={context} />
            <ol className="aw-app-channel-list" aria-label={strings.threadLabel} aria-live="polite">
              {open.replies.map((reply) => (
                <li key={reply.id}>
                  <ChannelMessage record={reply} context={context} />
                </li>
              ))}
            </ol>
            <ChannelComposer {...composer} label={strings.replyLabel} threadRoot={open.root.id} />
          </aside>
        )}
      </div>
    </section>
  );
}
