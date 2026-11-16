## The service-desk app

This project holds a portal app built with `@indx-workspace/app`. Its data lives in the
PostgreSQL schema `app_service_desk`; agents reach it through the `service-desk` MCP connector, as the
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
- `npm run image` builds the app's image (`docker build -t service-desk .`). Push it and list its
  digest under `environments.production.apps.service-desk` for `aw deploy`; the image migrates its
  schema as it starts and answers `GET /api/health`.
- `aw destroy <app|resource|agent|page> <name>` shows what it would remove; add `--yes` to remove it.
  It refuses a file you have edited since it was generated.

## Next: the service desk

`--template desk` wrote the portal with the recipe pages (`/recipes`) and the dashboard
(`/dashboard`, which the home page opens). The app's name is its directory's, so a desk made with
`npm create @indx-workspace service-desk -- --template desk` is the app `service-desk`. These
commands add the tickets and the knowledge base, two recipes and two agents:

```sh
npx aw generate resource ticket title:text description:richText 'status:enum(new,in_progress,on_hold,resolved,closed)' 'priority:enum(p1,p2,p3,p4)' requester:person assignee:person --board status
npx aw generate resource kb_article title:text body:richText tags:tags
npx aw generate recipe triage-incident --on resource:ticket.created
npx aw generate recipe sla-sweep --on 'schedule:*/5 * * * *'
npx aw generate agent triage --tools ticket,kb_article
npx aw generate agent closer --tools ticket
```

`aw` is a dependency of this project, so it runs through `npx` (or `npm run`).
