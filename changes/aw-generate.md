---
changelog: aw
section: Added
---

- `aw generate app <name>` writes a portal app into the current directory (`app.config.ts`, its
  MCP route, layout and home page, its first migration and journal, `next.config.ts`,
  `tsconfig.json`, a dependency-cruiser boundary config and a GitHub-hosted CI workflow) and pins
  `@indx-workspace/app`, Next.js, React, Drizzle, `pg` and dependency-cruiser in `package.json`;
  it refuses a package already pinned at another version, and keeps an existing `README.md`.
- `aw generate resource <name> <field:type>... [--board <field>]` writes the resource, its
  migration `db/migrations/<NNNN>_create_<plural>.sql` with its journal entry, its two route files
  and its test, and adds it to `app.config.ts`. The migration SQL comes from the project's own
  `aw-app sql`; a missing or skewed app kit is refused as `app_kit_not_installed` (fix:
  `npm install`). A `ref()` to an unknown resource is refused.
- `aw generate agent <name> --tools <resource>[,...]` writes an agent on the app's MCP connector
  whose instructions name those resources' tools. `--tools` cannot restrict the agent to them: it
  reaches every tool of the app, and each call is still limited to what the person may do.
- `aw destroy <app|resource|agent> <name> [--yes]` shows what `aw generate` wrote for it and,
  with `--yes`, removes exactly that and reverts its one-line edits. It refuses a file edited since
  it was generated, a journal entry a later migration follows (write a drop migration instead),
  and an app that still has resources or agents. What was generated is recorded with each file's
  sha256 in `aw-generated.json`, which the project commits.
