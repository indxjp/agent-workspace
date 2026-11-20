---
changelog: contracts
section: Added
---

- `ApiRoute` takes an optional `description`, which the OpenAPI document publishes as the
  operation's `description`. The developer site names each HTTP API page after the operation
  summary, and two summaries broke the docs site build: the long `triggers.fire` summary made a
  file name longer than 255 bytes (ENAMETOOLONG), and the `?` in the
  `storage.connections.browse` summary cut its page URL short. Both summaries are now one short
  line, and the rest of their wording moved to their descriptions.
