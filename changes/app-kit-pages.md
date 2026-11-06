---
changelog: app
section: Added
---

- `definePages({ name?, space?, access, agents })`: the page resource kind, a preset over
  `defineResource` with the fields `title`, `parent`, `position`, `blocks` (and `space`), search
  over the title and the blocks' text, and a `<name>_revisions` table that `createTableSql`
  creates with the pages. The block model (`PAGE_BLOCK_TYPES`) and its one markdown conversion,
  `blocksToMarkdown`, `markdownToBlocks` and `blocksPlainText`, replace the agent tools' earlier
  paragraphs-and-headings conversion.
- `pageStoreOf` (`./db`) and `memoryPageStoreOf` (`./testing`): the tree (`children`, `move`
  refusing `page_cycle` and `page_space_mismatch`, a delete refused `page_has_children` unless
  `cascade`), one revision per save of the title or body with its author and the agent's run,
  `revisions` newest first, `restore`, and `expectedRevisionId` refused `409 page_conflict` when
  stale. Revisions outlive their page. Search splits Japanese into character pairs
  (`searchTerms`, `searchQuery`), so it needs no database extension.
- `pageRoutes(resource)` (`./server`): `GET /api/<plural>/:id/revisions`, `POST …/restore` and
  `POST …/move`. A page resource's agent tools add `<name>_children` and
  `<name>_create(parent, title, markdown)`, the only create tool, and its `<name>_update` takes
  `markdown` and `expectedRevisionId`.
