---
changelog: sdk
section: Added
---

- `@indx-workspace/sdk/project` renders app templates for `create --template`:
  `renderAppTemplate('portal', { appName, version, existing })` returns the `app` template, the
  portal's pages over it and the `aw-generated.json` entry recording them, with the packages to
  pin; `withAppPackages` adds those pins to `package.json`; `appKitPackages` and `APP_TEMPLATES`
  are the pins and the template list `aw generate app` and `create` share.
- The generated app's CI (`app-ci.yml`) now cruises the whole project, so an app with no
  `resources/` yet passes, and also refuses a private-scope or `workspace:` dependency in
  `package.json`; its dependency-cruiser rule is `app-imports-only-published-packages`, which
  refuses the private packages' imports as well as `apps/*`.
