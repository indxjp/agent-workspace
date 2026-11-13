---
changelog: platform
section: Added
---

- The home chat's "+ Files" picker lists the workspace files and folders the chosen agent is
  granted, with each one's access, and the picks narrow the chat: the first message and every
  follow-up are sent with the picked paths as the run's `fileScope`. The run start re-checks each
  path against the agent's grants and refuses one outside them (`run_file_scope_not_granted`), so a
  pick never widens access; picking nothing keeps every grant, as before. The list is shown only to
  someone who may read the agent's resources. Storage-connection folders are not listed, since
  `fileScope` narrows workspace files only. On a phone the composer's pickers now span the screen
  instead of running off it (#2089, RF-502).
