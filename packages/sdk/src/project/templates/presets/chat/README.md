
## Next: the team chat

`--template chat` wrote the portal with the recipe pages (`/recipes`) and a home page that links to
the channels once they exist. These commands add the channels, the messages, their live updates, an
agent and a recipe that answers a mention:

```sh
npx aw generate resource channel name:text 'kind:enum(public,private,dm)'
npx aw generate resource message 'channel:ref(channel)' body:richText attachments:files 'thread_root:ref(message)'
npx aw generate channel message
npx aw generate agent helper --tools channel,message
npx aw generate recipe on-mention --on resource:message.created
```

`aw` is a dependency of this project, so it runs through `npx` (or `npm run`).
