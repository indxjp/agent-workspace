# {{agentName}}

An agent that looks up orders. It has two tools and a fake orders API to call, so nothing here
needs an external service.

## File map

```text
agents/{{agentName}}.ts        the agent: instructions, and the two tools it may call
tools/orders.ts                an API tool: openapiTool() over fake-api/openapi.json
tools/delivery-estimate.ts     a code tool: defineTool() declares it ...
tools/delivery-estimate.run.ts ... and this file is the function aw dev runs
fake-api/server.ts             the fake orders API (node:http, ORDERS_URL or port 4010)
fake-api/openapi.json          its OpenAPI document
surfaces/main.ts               the chat page
evals/{{agentName}}.yaml       three cases `aw eval` runs
agent-workspace.yaml           the project file
```

## Run it

```sh
node fake-api/server.ts        # terminal 1: the fake API
npm install && npm run dev     # terminal 2: aw dev, with your ANTHROPIC_API_KEY set
# terminal 3, while both of the above keep running (the tools call the fake API):
npx aw check                   # what would be saved, tool by tool
npx aw chat -p "Where is order A-1042, and is it late?"
npx aw eval                    # runs evals/{{agentName}}.yaml
```

Port 4010 busy? Set the same `ORDERS_URL` (for example `http://127.0.0.1:4011`) in terminals 1
and 2: the fake API listens there and `delivery_estimate` calls it. `orders` calls the first
`servers` URL of `fake-api/openapi.json`, so set that URL too.

## Change these first

1. The agent's `instructions` in `agents/{{agentName}}.ts`: say what your tasks are.
2. The API: set `spec` in `tools/orders.ts` to your OpenAPI document (add `auth: secret('...')` for
   a credential), and set `ORDERS_URL` when you start `aw dev` so `delivery_estimate` calls it too.
3. The eval cases in `evals/{{agentName}}.yaml`: ask what your users ask and say what must be true.

Code tools run only under `aw dev`: `aw push` to another environment and `aw promote` refuse a
version that uses one.
