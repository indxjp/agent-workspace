# @indx-workspace/create

`npm create @indx-workspace@latest <directory>` generates an Agent Workspace project.

npm maps `npm create @indx-workspace` to this package and runs its one bin, which is
`create-indx-workspace`, which runs `create-agent-workspace` from
[`@indx-workspace/cli`](https://www.npmjs.com/package/@indx-workspace/cli) at the same version: the
same arguments (`[--yes] | [--cloud aws|gcp|azure|local] [--validate]`), the same generated project
and the same refusals.

## The default: a v2 project

Without `--cloud`, `create` writes a v2 project: a `package.json` that pins `@indx-workspace/aw`,
`@indx-workspace/embedded` and `@indx-workspace/sdk` at this version, `agent-workspace.yaml`, the
agent under `agents/` and the surface under `surfaces/`. It asks the setup questions on a terminal
(an empty answer takes the recommended one) and shows the files before writing them. `--yes` takes
the recommended answers without asking and installs the dependencies; without a terminal, `create`
takes the recommended answers and says so on stderr. No `.env` and no key is written: `aw dev` reads `ANTHROPIC_API_KEY` from
its environment.

```sh title="illustrative" claim="illustrative"
npm create @indx-workspace@latest acme-ai
npm create @indx-workspace@latest acme-ai -- --yes
# on a terminal it then offers to install and start; without one: cd acme-ai && npm run dev
```

## A deployment project

`--cloud local|aws|gcp|azure` keeps the deployment project. A generated `local` project is the
Compose project, whose answers are `--database`, `--storage`, `--runtime` and `--auth` (or the defaults with `--yes`), and depends on `@indx-workspace/cli` at this
version, so `pnpm install && pnpm start` inside it runs `agent-workspace start`.

```sh title="illustrative" claim="illustrative"
npm create @indx-workspace@latest acme-ai -- --cloud local
npm create @indx-workspace@latest acme-ai -- --cloud gcp
```

## Flags go after `--`

npm reads every option before `--` as its own: `npm create @indx-workspace acme-ai --yes` gives
`--yes` to npm, not to the generator. Put the generator's flags after `--`, as above.

Released in lock-step with `@indx-workspace/contracts`, `sdk`, `aw` and `cli` (ADR-0082).
