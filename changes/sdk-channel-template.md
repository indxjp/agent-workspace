---
changelog: sdk
section: Added
---

- The `channel` generator template (issue #1519) and its spec: `renderChannelSpec(resource,
  { key?, refs })` keys the channel on a `ref()` field (`--key`, else the first `ref()` to another
  resource, found by `refFieldsOf` in the resource's file) and refuses with `channel_key_required`
  when there is none; `channelRouteEdits(resource)` are the one-line edits of the resource's two
  route files that pass `{ publish }`. `aw-generated.json` records the `channel` kind, and an edit
  may name the line it `replaced`, which `aw destroy` puts back.
