---
changelog: aw
section: Added
---

- `aw dev` runs a generated app. With an `app:<name>` entry in `aw-generated.json`, after the
  runtime is ready it migrates the app's schema `app_<name>` (`aw-app migrate`, spawned from the
  project's own install), starts `next dev` on `127.0.0.1` on the first free port from the web port
  plus 100, and registers the app's MCP endpoint as the connector `<name>` with
  `identity: { secret: APP_<NAME>_IDENTITY }` through the same plan as the project file's
  connectors, without editing `agent-workspace.yaml`. The identity key is made on the first run
  and kept in `.aw/app-identity.json` (`0600`); it is never printed. `aw dev` stores it as that
  workspace secret where its key may, and otherwise (secrets are an Owner's, the runtime's key an
  Admin's) prints a `notice:` naming the secret an Owner adds in the console and the file its value
  is in. The ready screen shows an `app` row. A connector named like the app that `aw dev` did not
  create is refused as `app_connector_conflict`.
