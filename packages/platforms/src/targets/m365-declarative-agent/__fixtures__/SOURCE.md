# Vendor fixtures

Documents Microsoft publishes, kept here so the importer is tested against what the vendor writes and not only against what this target emits. Prettier formats the JSON files (whitespace only).

| Fixture                              | Source                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `learn-declarative-agent-v1.8.json`  | https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.8, section "Declarative agent manifest example" (page `updated_at` 2026-09-30).                                                                                                                                                                                     |
| `learn-plugin-v2.4-mcp-dynamic.json` | https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-dynamic-tool-discovery. The page shows `functions: []` and one `RemoteMCPServer` runtime with `run_for_functions: ["*"]`. `$schema`, `schema_version`, `name_for_human`, `namespace`, `description_for_human` and `auth: {type: "None"}` are added so the file is a complete v2.4 plugin. |
| `atk-new-declarative-agent/`         | Hand-rendered from the Microsoft 365 Agents Toolkit templates 6.18.0 (declarative agent template: `m365agents.yml.tpl`, `appPackage/manifest.json`, `appPackage/declarativeAgent.json`). Not captured from a real `atk new` run; the `v1.12` schema version and URL are unverified (VERIFY(V1), #962).                                                              |

## Caveats

- The Learn pages were read through the WebFetch tool, which passes the page through a small model. The JSON was checked against the page structure but a verbatim byte-for-byte copy is not guaranteed. Re-fetch before relying on a single value.
- `atk-new-declarative-agent/` is **hand-rendered** from the templates (`{{appName}}` replaced with `my-agent`, `appPackage/instruction.txt` written by hand), not the output of a real `atk new`: the CLI cannot run in the build environment. Regenerate it with `atk new` when it can.
- The upstream template writes `${{...}}` placeholders in `manifest.json` and `declarativeAgent.json`; they are kept as the toolkit writes them.
- The toolkit's `.env.dev` is not vendored: `.env*` files are never tracked in this repository.
