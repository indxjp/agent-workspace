---
changelog: platform
section: Fixed
---

- A tool call the agent's permissions refused, with nobody asked, is now said in the chat: "Did not
  run: Bash". Before, the run ended Completed and the answer could read as if the command had
  worked; the refusal was only in Show technical details. What Run commands allows is unchanged
  (part of #2091).
