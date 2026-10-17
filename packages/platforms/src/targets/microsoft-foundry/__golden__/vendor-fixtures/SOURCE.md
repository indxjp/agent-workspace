# Vendor fixtures

Shapes the Microsoft Foundry importer reads, kept next to the code so a vendor change shows up as
a failing test. Nothing here was run against a live Foundry project. The text was retrieved on
2026-10-11 through a markdown rendering of the Learn pages, not from a byte-checked copy of the
page source, so "verbatim" below means "copied from that rendering".

Microsoft Learn documentation is CC BY 4.0 and its code samples are MIT
(<https://github.com/MicrosoftDocs/azure-ai-docs>). The files are `.txt` because the vendor
`curl` bodies hold shell interpolation (`'$VAR'`, `<AGENT_NAME>`) and are not valid JSON; the test
substitutes placeholders before parsing.

| File | Status | Source | Page `git_commit_id` |
| --- | --- | --- | --- |
| `learn-mcp-agent.txt` | verbatim: the `-d '...'` body of step 3, "Create an MCP agent" (page lines 1352-1369) | <https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol> | `6b4472c639f838a3f7449ff364c2e6dcb1984425` |
| `learn-openapi-tool.txt` | verbatim: the `--data '...'` toolbox body under "Anonymous authentication" (page lines 882-938); the test wraps its `tools` into an agent version | <https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/openapi> | `3a4821ce933f2138280c8afcd5e0afc69e8bb187` |
| `learn-a2a-version.hand-rendered.txt` | hand-rendered, not verified: the `tools` entry of the TypeScript `createVersion` sample, with its `a2aConnection.id` variable written as `aw-agent-billing-specialist` | <https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/agent-to-agent> | `b3997ac801188b3c48a6f3d14946ceae36aa36b8` |
| `file-search-direct.hand-rendered.txt` | hand-rendered, not verified: a flat `vector_store_ids` on the tool, as the page describes | <https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/file-search> | `8083eed1aaa75fcd2fdd220cf6acb1cd4457becd` |

`git_commit_id` is the commit the Learn front matter reported for the page when it was fetched.
