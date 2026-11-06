## The crm app

This project holds a portal app built with `@indx-workspace/app`. Its data lives in the
PostgreSQL schema `app_crm`; agents reach it through the `crm` MCP connector, as the
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
- `npm run image` builds the app's image (`docker build -t crm .`). Push it and list its
  digest under `environments.production.apps.crm` for `aw deploy`; the image migrates its
  schema as it starts and answers `GET /api/health`.
- `aw destroy <app|resource|agent|page> <name>` shows what it would remove; add `--yes` to remove it.
  It refuses a file you have edited since it was generated.

## Next: the CRM

`--template crm` wrote the portal with the recipe pages (`/recipes`) and its own theme tokens in
`app/theme.ts`. These commands add the companies, contacts and deals, a recipe that enriches a new
contact, and the sales assistant:

```sh
npx aw generate resource company name:text domain:text
npx aw generate resource contact name:text email:text 'company:ref(company)' owner:person
npx aw generate resource deal name:text 'amount:money(JPY)' 'stage:enum(lead,qualified,proposal,won,lost)' owner:person --board stage
npx aw generate recipe enrich-contact --on resource:contact.created
npx aw generate agent sales-assistant --tools contact,company,deal
```

`aw` is a dependency of this project, so it runs through `npx` (or `npm run`).
