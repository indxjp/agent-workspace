# {{agentName}}

A copilot agent and a small Vite page in `web/` that chats with it through `@indx-workspace/react`.

## File map

```text
agents/{{agentName}}.ts   the agent: instructions
surfaces/main.ts          the surface the page talks to
web/index.html            the page
web/main.jsx              import '@indx-workspace/react/styles.css' and <Chat/> for the local project
web/package.json          the page's own packages (the agent project does not need them)
evals/{{agentName}}.yaml  two cases `aw eval` runs
agent-workspace.yaml      the project file
```

## Run it

```sh
npm install && npm run dev     # terminal 1: aw dev, with your ANTHROPIC_API_KEY set
cd web && npm install && npm run dev   # terminal 2: the page, on http://localhost:5173
npx aw eval                    # runs evals/{{agentName}}.yaml
```

`aw dev` prints its web origin; if it is not `http://127.0.0.1:3000`, change `baseUrl` in
`web/main.jsx` (or set `VITE_AW_BASE_URL`, which `aw deploy` does for a `target: vercel` environment). Under `aw dev` a page on any `localhost` port is allowed, so there is no CORS setup.

## Change these first

1. The agent's `instructions` in `agents/{{agentName}}.ts`: say what your copilot helps with.
2. `web/main.jsx`: pass `definition` (what `surfaces/main.ts` exports) for its theme, or replace a
   part with `components`.
3. The eval cases in `evals/{{agentName}}.yaml`: say what must be true of your answers.
