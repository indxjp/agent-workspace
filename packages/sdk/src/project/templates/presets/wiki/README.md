
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
