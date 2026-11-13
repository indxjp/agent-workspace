
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
