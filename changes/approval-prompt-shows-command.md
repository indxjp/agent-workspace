---
changelog: react
section: Changed
---

- `ApprovalPrompt` shows a `Bash` call whose only arguments are `command` and `description` as the
  command alone, with the full canonical call in a closed `<details>` (class
  `aw-approval-full-call`). Any other call is pretty-printed in full; text that is not this tool's
  canonical call is shown as it arrived. `ApprovalPromptStrings.approvalFullCall` labels the
  disclosure and is optional ("Full call" when left out); `surfaceStrings` has it in English and
  Japanese.
