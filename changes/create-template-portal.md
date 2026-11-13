---
changelog: cli
section: Added
---

- `npm create @indx-workspace <dir> -- --template portal` writes the project and a portal app over
  it: dashboard, chat, files and runs pages that call Agent Workspace as the signed-in person, a
  sign-in notice for nobody signed in, `app/theme.ts`, `app/nav.ts` and `en`/`ja` strings, the
  app's published-packages-only CI, and `aw-generated.json` recording it all. `package.json` gains
  the app kit's exact pins, the `@indx-workspace/*` ones at the version of `create`. An unknown
  template is refused naming the list, and `--template` with `--cloud` is refused.
