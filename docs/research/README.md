# Research evidence

Committed evidence captured from provider APIs and SDKs (wire transcripts, probe output, `R-01-options.json`). Tests and `pnpm release:check` read these files; do not edit them by hand.

- `R-01-options.json`: the Agent SDK option surface, extracted from the pinned SDK.
- `fixtures/agent-sdk/`: SDK surface extraction script and its reproduction notes.
- `fixtures/anthropic/`: Anthropic Messages wire transcripts.
- `fixtures/R-02/`: Sandbox Runtime probe output.
- `fixtures/R-04/`: OpenAI Responses probe output.
- `fixtures/R-04-operator-sentences.md`: operator-facing approximation sentences pinned by the gateway tests.
- `fixtures/R-06-mcp/`: MCP transport and auth probe output.
- `fixtures/R-14/`: Node runtime proxy probe output.
- `fixtures/R-05/`, `fixtures/R-07/`, `fixtures/R-08/`, `fixtures/R-09/`, `fixtures/R-10/`: Azure OpenAI, Azure Container Apps, Bedrock AgentCore, ECS Fargate and Cloud Run probe output.
- `fixtures/R-12-quotation-*.mjs`: quotation checks for the auth research.
