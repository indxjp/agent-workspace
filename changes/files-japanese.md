---
changelog: platform
section: Changed
---

- The Files screen is in Japanese for a Japanese reader: the heading, the upload and new-folder
  forms, the breadcrumb, the table (columns, file and folder types, Download, Rename and Delete, and
  the rename row), the empty and missing-folder lines, the delete questions, every upload line and
  each file's state, and the drop hint. The file picker that agent detail opens from "Add files or
  folders" follows the reader's language too. A refusal the server or the browser words keeps its
  own English sentence, marked `lang="en"`, after a Japanese lead; a line the screen words itself
  (a part-way move or delete, an upload over the limit) is said in Japanese. A refused create on the
  New Agent form now also leads in Japanese. English is unchanged (UX-15 in #2086).
