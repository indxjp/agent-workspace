---
changelog: platform
section: Added
---

- A chat opened from the sidebar's recent chats now shows its earlier messages above the composer:
  what you typed and what the agent answered, read from the Claude Agent SDK session transcript
  (spec §20). Tool calls, tool results and thinking are left out, as in the live chat. The last 40
  messages are shown, and the screen says how many older ones are not. They stay on screen when you
  send the next message (UX-05 step 2 in #2086).
