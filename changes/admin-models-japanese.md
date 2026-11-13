---
changelog: platform
section: Changed
---

- The Models screens are in Japanese for a Japanese reader: the provider list (heading, tabs, each
  row's status, detail line and buttons), Add Provider (every provider's name and description,
  every field, the Vertex AI locations) and a provider's detail panel (connection settings,
  credential rotation, removal with its agent preview). Each screen carries `lang`. A connection's
  name and settings, a test's result line and a refusal's message are shown as the server sends
  them. English is unchanged (UX-15 in #2086).
