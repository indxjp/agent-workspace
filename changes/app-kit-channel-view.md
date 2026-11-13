---
changelog: app
section: Added
---

- `ChannelView({ channel, resource, keyValue, threadField? })` in `./react` (F-11, issue #1519):
  the channel screen of a team chat, one key of a resource bound to a `channel()`. Its message list
  is live from the channel's stream with `aria-live="polite"` (an update replaces a message, a
  delete removes it, an event delivered twice is applied once); a thread pane opens on the
  resource's `ref()` to itself; the composer creates through `resourceClient`, with `@` mentions
  picked from `members` by named buttons and, given `uploadFile`, `files()` attachments; a
  presence row names who is here. Bodies render as Markdown without raw HTML. In `ja` and `en`.
  Its pure rules are exported too: `mergeChannelEvents`, `threadsOf`, `recordPresence`,
  `presentPrincipals`, `mentionsOf`, `channelFieldsOf`, `bodyTextOf`.
- `resourceRoutes(resource, { publish })` and `resourceItemRoutes(resource, { publish })` bind the
  resource to a channel: every write of it, through these routes or an agent tool
  (`mcpEndpoint`), publishes `{ type: 'created' | 'updated' | 'deleted', data: <record> }` on the
  key its `keyField` names, in the write's transaction. A `definePages` resource cannot be bound.
- `storeOf` and `memoryStoreOf` take an `afterWrite(tx, change)` hook, called inside the write's
  transaction after its audit row; unlike `onCommitted`, a hook that throws rolls the write back.
  The conformance suite holds both stores to it. `AfterWrite` and `WriteChange` are exported from
  `./db`.
- A channel's open stream announces its person on the key every 15 seconds with an ephemeral
  `presence` event (`{ principalId }`), first as it opens; `ChannelView` forgets a person 45
  seconds after their last one. The browser sends nothing for it, so there is no new route.
