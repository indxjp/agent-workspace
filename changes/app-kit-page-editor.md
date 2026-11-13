---
changelog: app
section: Added
---

- `PageTree`, `RichText` and `PageView` (`./react`): the wiki's parts over a `definePages`
  resource. `PageTree` is a WAI-ARIA tree whose levels load as they open, with the APG keyboard
  map, "New page", and a "Move to…" dialog that offers only the places a page may go (no drag and
  drop). `RichText` is a block editor without an editor dependency: a row per block with a type
  select and a labelled `<textarea>`; Enter at the end splits, Backspace at the start merges,
  Alt+Up / Alt+Down reorders, and `readOnly` draws the body through `AssistantProse`. `PageView`
  saves with `expectedRevisionId`, offers "Load latest" or "Keep mine" on `409 page_conflict` and
  never merges, and has a revisions drawer with an agent badge and run link on an agent's
  revision, a preview, and Restore.
- "Rewrite with <agent>" and "Summarize into new page": `PageView` opens the `AgentPanel` with a
  prompt from `rewritePrompt` / `summarizePrompt` naming the page, the tool and
  `expectedRevisionId`; the agent's change lands as a new revision with its run, and the view
  loads it when the run completes.
- `AgentPanel` takes `initialPrompt` and `initialAgent`, and its `onCompleted` is told the run and
  its agent; both are backwards compatible.
- `pageClient(resource)`: the page routes from the browser (`get`, `children`, `create`,
  `update`, `move`, `revisions`, `restore`), each answer parsed and each failure one
  `ResourceProblemError`. `pageRoutes(resource).children` (`./server`) serves
  `GET /api/<plural>/children?parent=<id>` (the top without `parent`) for the tree.
