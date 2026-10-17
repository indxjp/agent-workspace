# AgentCore CLI vendor fixtures

Verbatim copies of the public example `examples/AgentCoreCliReviewer` of the AWS-official AgentCore
CLI. They are test data for `../../vendor-fixtures.test.ts` and are never executed or shipped. Do not
edit them: a changed byte breaks the provenance below. Replace them only with a newer pinned commit,
and update this file.

- Repository: https://github.com/aws/agentcore-cli
- Commit: `dd6304eef85dac8135acb01579a1cf41313148e5` (v0.31.1, committed 2026-10-05)
- Licence: Apache-2.0, Copyright Amazon.com, Inc. or its affiliates (upstream `NOTICE`). The
  licence text is `LICENSE` in this directory, copied verbatim (blob
  `67db8588217f266eb561f75fae738656325deac9`).
- Retrieved: 2026-10-12, with
  `curl https://raw.githubusercontent.com/aws/agentcore-cli/<commit>/<path>`. Each file's git blob
  SHA matches the blob at that commit (`git hash-object`).

| File (under `AgentCoreCliReviewer/`, same path as upstream) | Blob SHA                                   | URL                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agentcore/agentcore.json`                                  | `01cd78559fd843b861fd37944d699b0f37303358` | https://github.com/aws/agentcore-cli/blob/dd6304eef85dac8135acb01579a1cf41313148e5/examples/AgentCoreCliReviewer/agentcore/agentcore.json        |
| `app/PRReviewer/harness.json`                               | `861df899d1cd75727645657f8ab76be5977be981` | https://github.com/aws/agentcore-cli/blob/dd6304eef85dac8135acb01579a1cf41313148e5/examples/AgentCoreCliReviewer/app/PRReviewer/harness.json     |
| `app/PRReviewer/system-prompt.md`                           | `52a3d2260059ed53efc5975ae282ca6fde83a084` | https://github.com/aws/agentcore-cli/blob/dd6304eef85dac8135acb01579a1cf41313148e5/examples/AgentCoreCliReviewer/app/PRReviewer/system-prompt.md |

The example's `agentcore/aws-targets.json`, `agentcore/cdk/`, `Dockerfile` and Python files are not
copied: no test reads them.

The example has no tools, no credentials and no `allowedTools`, so it cannot settle V1-V3. An item is
confirmed only by a cited AWS docs page together with a committed fixture that exercises it; the CLI
source below is supporting evidence only:

- `HARNESS` = https://github.com/aws/agentcore-cli/blob/dd6304eef85dac8135acb01579a1cf41313148e5/src/schema/schemas/primitives/harness.ts
- `MAPPER` = https://github.com/aws/agentcore-cli/blob/dd6304eef85dac8135acb01579a1cf41313148e5/src/cli/commands/export/harness-mapper.ts

## VERIFY outcomes

- **V1** `Bearer ${<token-vault ARN>}` interpolated with its prefix: **VERIFY**. Nothing in the CLI
  repository shows `${arn:…}` interpolation; `MAPPER` treats every remote MCP header value as a raw
  secret. Needs the AWS harness-tools page or a live harness.
- **V2** the last path segment of the token-vault ARN is the `credentials[].name`: **VERIFY**.
  Supporting evidence only (CLI mapper source, not AWS docs): `MAPPER` L641-L652 documents the ARN as
  `arn:aws:bedrock-agentcore:<region>:<account>:token-vault/<vault>/apikeycredentialprovider/<name>`
  and writes `<name>` as the `ApiKeyCredentialProvider` credential name.
- **V3** `allowedTools` plain names `code_interpreter` and `browser`: **VERIFY**. Supporting
  evidence only (CLI mapper source, not AWS docs): `MAPPER` `isToolIncluded` and `matchesAllowedTools` (L1020-L1049, "mirrors Harness runtime \_matches()")
  include a tool when an entry equals its `name`. For `@<gateway tool name>` covering a gateway tool
  the mapper's flat-name branch does not match it.
- **V4** Bedrock ids: `us.anthropic.claude-opus-4-7` is **confirmed** by
  `app/PRReviewer/harness.json`. Ids beyond the three rows of `BEDROCK_CLAUDE_MODEL_IDS` stay
  **VERIFY**.
- **V5** `agentcore deploy` accepts the emitted overlay: **VERIFY** (U3b, needs an AWS account). The
  example's `agentcore.json` has the same `$schema`, `version: 1` and `managedBy: "CDK"`.

Two open questions from the compile slice:

- `allowedTools: []` allows no tool: **VERIFY**. Supporting evidence only (CLI source, not AWS
  docs): `HARNESS` `allowedTools: z.array(AllowedToolSchema).optional()`
  has no minimum, and `MAPPER` turns only an omitted list into `['*']` (L83); `matchesAllowedTools`
  matches nothing for `[]`, so it allows no tool, builtins included.
- `model` omitted: **rejected upstream**. `HarnessSpecSchema.model` in `HARNESS` is required. compile
  still omits it for an agent without a model, and `harness-spec.subset.ts` keeps it optional until
  a follow-up decides the mapping.
