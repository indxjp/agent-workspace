---
changelog: sdk
section: Added
---

- The app template (`aw generate app`, `create --template portal`) builds an image for
  `aw deploy`: a two-stage `Dockerfile` on a digest-pinned Node.js 24 image that copies Next.js's
  standalone output, its static files and `db/migrations`, and runs as `node` on port 3000; a
  `.dockerignore`; `instrumentation.ts`, which applies the app's migrations as the server starts
  when `AW_APP_MIGRATE_ON_START=1` and exits on a failed one; and `app/api/health/route.ts`, which
  answers `ok` with `no-store` without reading the app's settings. `package.json` gains the script
  `image` (`docker build -t <app> .`), recorded in `aw-generated.json` so `aw destroy app` removes
  it; a project's own `image` script is kept. `appScripts` and `scriptEdit` are exported from
  `@indx-workspace/sdk/project`.
