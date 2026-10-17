# @agent-workspace/schemas

JSON Schemas for the files an Agent Workspace project commits, so an editor can validate and
complete them as they are typed.

| File                          | Describes                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `agent-workspace.schema.json` | `agent-workspace.yaml`, `apiVersion: agentworkspace.dev/v1`, `kind: Deployment` |

Every file here is **generated**; never edit one by hand. `agent-workspace.schema.json` (JSON
Schema draft 2020-12) is converted from the Zod definition the CLI validates with,
`packages/cli/src/profile-schema.ts`, by `packages/cli/scripts/generate-profile-schema.mjs`, which
writes the same file to `packages/cli/schema/` for the published `@indx-workspace/cli` to ship:

```sh title="illustrative" claim="illustrative"
pnpm docs:generate   # rewrite it after changing the definition
pnpm docs:check      # fails when either committed copy is stale; part of pnpm check:fast
```

`agent-workspace validate` stays authoritative. It also makes the checks JSON Schema has no form
for — a `postgres://` connection string and the OIDC issuer must parse as URLs — which
`CLI_ONLY_PROFILE_CHECKS` in `profile-schema.ts` lists and `profile-schema.test.ts` pins.

## Using it

A profile `create-agent-workspace` writes starts with the line that points the
[YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) (and any
editor using `yaml-language-server`) at the schema of the CLI release that wrote it:

```yaml title="illustrative" claim="illustrative"
# yaml-language-server: $schema=https://unpkg.com/@indx-workspace/cli@0.2.1/schema/agent-workspace.schema.json
```

Add that line to a profile written by an earlier release, with the version of the CLI you run. The
URL and why it names the CLI tarball's copy on unpkg are recorded in
[ADR-0091](../../docs/adr/0091-the-deployment-profile-json-schema-is-generated-from-the-cli-zod-schema.md).

CLI 0.2.1 was published before it shipped the schema, so the URL a 0.2.1 profile names does not
resolve and the editor silently stops validating; it resolves from the first CLI release after
0.2.1. To validate without the network, point the first line at the installed CLI's copy:

```yaml title="illustrative" claim="illustrative"
# yaml-language-server: $schema=./node_modules/@indx-workspace/cli/schema/agent-workspace.schema.json
```

This package is private and is not published: the CLI's tarball carries the file editors read.
