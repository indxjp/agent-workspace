---
changelog: aw
section: Added
---

- `aw generate channel <resource> [--key <refField>]` (issue #1519) binds a resource to a realtime
  channel: it writes `channels/<resource>.ts`, its events route
  `app/api/channels/<resource>/events/route.ts` and its `ChannelView` page
  `app/channels/<resource>/[key]/page.tsx`, and edits each of the resource's two route files by
  one line to pass `{ publish: <channel> }`. A resource with no `ref()` field to key on is refused
  with `channel_key_required`. `aw destroy channel <resource>` removes exactly that, restores the
  route lines, and refuses a file edited since by name.
