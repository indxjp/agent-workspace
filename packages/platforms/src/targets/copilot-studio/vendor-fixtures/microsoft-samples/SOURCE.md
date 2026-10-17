# Source of the Microsoft sample fixtures

Verbatim copies of public Copilot Studio workspace samples. They are test data for
`../../vendor-samples.test.ts` and are never executed or shipped. Do not edit them: a changed byte
breaks the provenance below. Replace them only with a newer pinned commit, and update this file.

- Repository: https://github.com/microsoft/skills-for-copilot-studio
- Commit: `fd9653d0ec743b39443596d7132f907d0d993f1f` (committed 2026-09-09)
- Licence: MIT, Copyright (c) 2026 Microsoft Corporation (full text below)
- Retrieved: 2026-10-11, with `gh api repos/microsoft/skills-for-copilot-studio/contents/<path>?ref=<commit>`.
  Each file's git blob SHA matches the blob at that commit.

| File (same path in the repository)                          | Blob SHA                                   | URL                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `templates/agents/agent.mcs.yml`                            | `77800e5bdf3f0a270000a830f09a387194f55d52` | https://github.com/microsoft/skills-for-copilot-studio/blob/fd9653d0ec743b39443596d7132f907d0d993f1f/templates/agents/agent.mcs.yml                    |
| `templates/agents/child-agent.mcs.yml`                      | `e985c8ed6edb310075b8ce723ea221459ee01fe7` | https://github.com/microsoft/skills-for-copilot-studio/blob/fd9653d0ec743b39443596d7132f907d0d993f1f/templates/agents/child-agent.mcs.yml              |
| `templates/actions/mcp-action.mcs.yml`                      | `634875514769659761208fd85985ab73301d5485` | https://github.com/microsoft/skills-for-copilot-studio/blob/fd9653d0ec743b39443596d7132f907d0d993f1f/templates/actions/mcp-action.mcs.yml              |
| `templates/knowledge/public-website.knowledge.mcs.yml`      | `a000a81e4b306bf7c8ccacc81b226a502bfc7710` | https://github.com/microsoft/skills-for-copilot-studio/blob/fd9653d0ec743b39443596d7132f907d0d993f1f/templates/knowledge/public-website.knowledge.mcs.yml |
| `evals/fixtures/agent-with-mcp-action/agent.mcs.yml`        | `37faedee8e799f4f74cc93fd4da0306f53486991` | https://github.com/microsoft/skills-for-copilot-studio/blob/fd9653d0ec743b39443596d7132f907d0d993f1f/evals/fixtures/agent-with-mcp-action/agent.mcs.yml |
| `evals/fixtures/agent-with-mcp-action/settings.mcs.yml`     | `c7ff4066932cfb5a9af875ce6e246117ff465ca9` | https://github.com/microsoft/skills-for-copilot-studio/blob/fd9653d0ec743b39443596d7132f907d0d993f1f/evals/fixtures/agent-with-mcp-action/settings.mcs.yml |
| `evals/fixtures/agent-with-mcp-action/actions/CustomMCP.mcs.yml` | `ef947e7346fa946758bf2cc3fb61a9a208108aab` | https://github.com/microsoft/skills-for-copilot-studio/blob/fd9653d0ec743b39443596d7132f907d0d993f1f/evals/fixtures/agent-with-mcp-action/actions/CustomMCP.mcs.yml |

`reference/bot.schema.yaml-authoring.json` at the same commit (856 KB, not committed) is cited in the
test notes for keys the samples do not carry: `GptComponentMetadata.gptCapabilities`
(`GptCapabilities.webBrowsing`, `.codeInterpreter`) and `ModelContextProtocolMetadata.tools`
(`UseSpecificTools.kind`, `.tools`).

These samples are Microsoft's GitHub samples, not a real tenant export. P3b (#970) verifies the
shapes against a tenant clone.

## Licence

```text
MIT License

Copyright (c) 2026 Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
