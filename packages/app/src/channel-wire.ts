/**
 * A `channel()` stream's wire (issue #1518): the path `channel(…).routes()` serves, the names of
 * its frames and their payloads, which `useChannel` in `./react` reads. One module, so the two
 * halves cannot drift. Pure Zod, with no server or browser dependency; not a public entry point.
 *
 * The stream writes three frames, and never one named `error`:
 *
 * - `channel-event` carries one durable event and its `id:`, the resume cursor;
 * - `channel-ephemeral` carries a notify-only event (presence, typing), with no `id:`;
 * - `stream-reset` says the cursor could not be served: the client discards what it holds, and
 *   the stream goes on after `resumedAfter`.
 */
import { z } from 'zod';

/** The frame of a durable event. */
export const CHANNEL_EVENT_FRAME = 'channel-event';
/** The frame of an ephemeral event. */
export const CHANNEL_EPHEMERAL_FRAME = 'channel-ephemeral';
/** The frame that says the cursor could not be served. */
export const STREAM_RESET_FRAME = 'stream-reset';

/** A channel's name: lower-case, starting with a letter, at most 63 characters. */
const CHANNEL_NAME = /^[a-z][a-z0-9_-]{0,62}$/u;
/** An event's type: the platform's event-name grammar. */
const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
/** A key is a record id or another short printable name: no control characters, no `:`. */
const CHANNEL_KEY = /^[^\p{Cc}:]{1,200}$/u;

export const ChannelNameSchema = z.string().regex(CHANNEL_NAME);
export const ChannelEventTypeSchema = z.string().regex(EVENT_TYPE);
export const ChannelKeySchema = z.string().regex(CHANNEL_KEY);

/** Where a channel's stream is served: `app/api/channels/<name>/events/route.ts`. */
export function channelEventsPath(name: string): string {
  return `/api/channels/${encodeURIComponent(name)}/events`;
}

/** The payload of a `channel-event` frame; its `id:` is the frame's own. */
export const ChannelEventPayloadSchema = z.strictObject({
  key: ChannelKeySchema,
  type: ChannelEventTypeSchema,
  data: z.unknown(),
  at: z.string(),
});
export type ChannelEventPayload = z.infer<typeof ChannelEventPayloadSchema>;

/** The payload of a `channel-ephemeral` frame. */
export const ChannelEphemeralPayloadSchema = z.strictObject({
  key: ChannelKeySchema,
  type: ChannelEventTypeSchema,
  data: z.unknown(),
});
export type ChannelEphemeralPayload = z.infer<typeof ChannelEphemeralPayloadSchema>;

/** The ephemeral event type an open stream announces its person with (issue #1519). */
export const PRESENCE_EVENT = 'presence';
/** How often an open stream announces its person. */
export const PRESENCE_HEARTBEAT_MS = 15_000;
/** How long after a person's last heartbeat a `ChannelView` stops showing them. */
export const PRESENCE_EXPIRY_MS = 45_000;

/** The data of a `presence` event: who is here. */
export const ChannelPresenceSchema = z.strictObject({
  principalId: z.string().min(1).max(200),
});
export type ChannelPresence = z.infer<typeof ChannelPresenceSchema>;

/** The payload of a `stream-reset` frame: why, and the id the stream goes on after. */
export const StreamResetPayloadSchema = z.strictObject({
  reason: z.string(),
  resumedAfter: z
    .string()
    .regex(/^\d{1,19}$/u)
    .nullable(),
});
export type StreamResetPayload = z.infer<typeof StreamResetPayloadSchema>;
