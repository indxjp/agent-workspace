
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
