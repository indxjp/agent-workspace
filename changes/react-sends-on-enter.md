---
changelog: react
section: Added
---

- `sendsOnEnter(event)` is exported: whether a composer's keydown should send, as `<Chat/>` decides
  it (Enter sends, Shift+Enter adds a new line, an Enter that confirms IME input never sends), so
  another chat's composer behaves the same.
