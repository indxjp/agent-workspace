# Platform report: Claude Managed Agents

Agent `support` exported to `claude-managed-agents`.

| Field | Verdict | Code | Why |
| --- | --- | --- | --- |
| support.instructions | native |  | Emitted as the Markdown body, which is the system prompt |
| support.model | native |  | Emitted as the model |
| support.engine | dropped | field_unsupported | Managed Agents runs its own harness; the engine choice does not apply |
| support.permissions.readFiles | mapped |  | Enables the sandbox file tools read, glob and grep (not workspace files) |
| support.permissions.writeFiles | mapped |  | Enables the sandbox file tools write and edit (not workspace files) |
| support.permissions.runCommands | mapped |  | Enables the sandbox shell: the bash tool |
| support.permissions.unrestrictedNetwork | mapped |  | The environment networking type is limited, with allow_mcp_servers |

2 native · 4 mapped · 1 dropped
