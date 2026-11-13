## The wiki app

This project holds a portal app built with `@indx-workspace/app`. Its data lives in the
PostgreSQL schema `app_wiki`; agents reach it through the `wiki` MCP connector, as the
person who asked and never beyond what that person may do.

```text
app.config.ts       the app and its resources
resources/          one file per resource: the source of its table, routes and tools
app/api/            the generated route files, each re-exporting an app-kit handler
app/<plural>/       a resource's list, detail, edit and new pages, each mounting an app-kit part
db/migrations/      the app's migrations, applied in order
Dockerfile          the app's image, which npm run image builds
instrumentation.ts  migrates the app's schema as the image starts
aw-generated.json   what aw generate wrote, so aw destroy removes exactly that
```

- `aw generate resource <name> <field:type>...` adds a resource, its migration, routes, pages and
  test.
- `aw generate page <name> --kind dashboard|list|custom [--resource <resource>]` adds
  `app/<name>/page.tsx`; a dashboard also adds its route, `app/api/dashboard/route.ts`.
- `aw generate agent <name> --tools <resource>` adds an agent that uses the app's tools.
- `npm run build` is `next build`, which the image runs too.
- `npm run image` builds the app's image (`docker build -t wiki .`). Push it and list its
  digest under `environments.production.apps.wiki` for `aw deploy`; the image migrates its
  schema as it starts and answers `GET /api/health`.
- `aw destroy <app|resource|agent|page> <name>` shows what it would remove; add `--yes` to remove it.
  It refuses a file you have edited since it was generated.

## Next: the wiki

`--template wiki` wrote the portal with the wiki's resources, `space` and `page` (pages nest, keep
a rich-text body and leave a revision on every save), their routes, the wiki (`/wiki`, a space's
page tree, and `/wiki/<id>`, one page with its revisions), the space pages (`/spaces`) and the
recipe pages (`/recipes`). This command adds the agent that writes pages, `page_create` included:

```sh
npx aw generate agent writer --tools page
```

Then offer it on the page: name it in the `agents` list of `app/wiki/[id]/page.tsx`, and serve the
agent panel from `app/api/agent-panel/[...path]/route.ts` with `agentPanelRoutes` from
`@indx-workspace/app/server`.

`aw` is a dependency of this project, so it runs through `npx` (or `npm run`).
