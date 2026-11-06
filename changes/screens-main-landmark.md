---
changelog: platform
section: Fixed
---

- Files, Skills, a skill, Connectors, New connector, API Keys and Settings now have a `<main>`
  landmark and the same page margin as the other screens, instead of sitting flush against the
  sidebar (UX-24 in #2086).
- A person who opens Storage, a storage connection, Connect storage or Runtimes without the role
  for it now sees the screen's heading and the refusal inside the page's `<main>` landmark, with
  the same margin, instead of a bare line of text.
