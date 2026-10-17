# Changelog — `@agent-workspace/gateway`

One heading per change set, newest first. The package is private; this file records behavior a
deployer or a test author can observe.

## Unreleased

### Fixed

- `POST /v1/tool-sandbox/mcp` appends `/mcp` to the run's tool sandbox origin instead of resolving
  it, so an origin with a path (the runner manager's `/tool-sandboxes/<id>` on a hosted
  deployment) keeps it (issue #827).
- For such an origin the gateway sends `RUNNER_MANAGER_TOKEN` (when it is set) as `authorization`
  and the run's tool token as `x-aw-tool-authorization`, because the manager's route now requires
  both (ADR-0132). A container origin still gets only the tool token.

### Added

- `POST /v1/tool-sandbox/endpoint/mcp` forwards an endpoint's MCP call to its tool sandbox. It is
  authorised by a 60-second `tool-endpoint` grant the control plane signs (`awg.<payload>.<sig>`),
  not by a run token (ADR-0134 part 2, issue #967).

- The gateway runs as a Vercel Function (issue #830, ADR-0126): `api/index.ts` serves
  `createGatewayFromEnvironment(env)`, which `main` now also uses. Not yet run on Vercel.
- Tool sandbox route (issue #847, ADR-0118 TS3): `POST /v1/tool-sandbox/mcp` forwards a run's code-tool
  MCP request to the sandbox origin recorded on the run (`runs.tool_sandbox_origin`), authenticated
  by the run token alone and only while the run is active. The gateway adds the sandbox's own
  per-run bearer (`toolSandboxRunToken`) and drops the caller's `authorization` and `x-aw-run-id`;
  a sandbox that is down answers `502 tool_upstream_failed`, one that is slow `504
  tool_upstream_timeout`. Never metered, never resolves the model key. Spec §9 lists eight routes.

- Scripted models (issue #798): a model id `scripted:<name>` on an Anthropic-family
  connection replays `<name>.json` from `AW_SCRIPTED_MODELS_DIR` instead of calling a provider. It
  is a test tool: with the variable set outside the `local` deployment posture, or set to a relative
  path, `createProviderRegistry` throws, so the gateway and the web process refuse to start. With
  the variable unset (every deployment) nothing changes. `createProviderRegistry({ scripted })`
  takes the opt-in explicitly; `null` turns it off.
- On an OpenAI connection, `/v1/messages`, `/v1/responses` and `/v1/chat/completions` answer a
  `scripted:` model with `400 scripted_model_protocol_unsupported`, and `/v1/messages/count_tokens`
  answers with the local estimate, so a `scripted:` id never reaches the provider (only when
  scripted models are enabled).
