---
changelog: sdk
section: Added
---

- `renderAppTemplate` renders four presets over the portal: `chat`, `wiki`, `crm` and `desk`
  (`APP_PRESETS`). Each adds the recipe pages and their four routes, and its own overlay: chat a
  home page that links to its channels once they exist; wiki the `space` and `page` resources,
  their migration `0003_wiki`, routes, the wiki pages and the space pages; crm its theme tokens;
  desk the dashboard page. A later layer writing a path an earlier one wrote is refused unless the
  preset lists it in `replaces`. The app is named after the project, never the template, and
  `aw-generated.json` records the wiki's resources as `resource:space` and `resource:page` and the
  desk's dashboard as `page:dashboard`, so `aw destroy` removes them as generated ones. Each
  preset's README section lists its follow-up `npx aw` commands, shell-quoted.
