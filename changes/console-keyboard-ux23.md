---
changelog: platform
section: Fixed
---

- Console keyboard use (UX-23 in #2086): every signed-in console screen starts with a "Skip to
  content" link that moves focus to the page (New Agent's Builder chat now has exactly one main
  region while it loads, fails or chats, so the link always lands there); the home chat box shows
  when it has focus; Esc closes the Agent, Files and Connectors pickers; Enter sends in the home
  chat (Shift+Enter adds a new line). Enter no longer sends while Japanese input is still being
  converted, in the home chat or a run's follow-up box.
