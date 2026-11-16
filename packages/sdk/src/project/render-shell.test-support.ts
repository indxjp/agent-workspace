export const EXPECTED_PACKAGE_JSON = `{
  "name": "my-project",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "dev": "aw dev"
  },
  "dependencies": {
    "@indx-workspace/aw": "0.3.0",
    "@indx-workspace/embedded": "0.3.0",
    "@indx-workspace/sdk": "0.3.0",
    "@anthropic-ai/claude-agent-sdk": "0.3.316",
    "@anthropic-ai/sdk": "1.3.0"
  },
  "devDependencies": {
    "@indx-workspace/cli": "0.3.0"
  },
  "allowScripts": {
    "@embedded-postgres/darwin-arm64": true,
    "@embedded-postgres/darwin-x64": true,
    "@embedded-postgres/linux-arm": true,
    "@embedded-postgres/linux-arm64": true,
    "@embedded-postgres/linux-ia32": true,
    "@embedded-postgres/linux-ppc64": true,
    "@embedded-postgres/linux-x64": true,
    "@embedded-postgres/windows-x64": true,
    "esbuild": false,
    "@google/genai": false,
    "protobufjs": false
  },
  "overrides": {
    "undici@>=7.0.0 <7.30.1": "^7.30.1",
    "undici@>=8.0.0 <8.12.2": "^8.12.2",
    "body-parser@>=2.0.0 <2.4.0": "^2.4.0",
    "@azure/msal-node@>=5.0.0-beta.0 <7.1.0": "^7.1.0",
    "@modelcontextprotocol/server@>=2.0.0 <2.3.0": "^2.3.0",
    "@modelcontextprotocol/client@>=2.0.0 <2.3.0": "^2.3.0",
    "@modelcontextprotocol/core@>=2.0.0 <2.3.0": "^2.3.0",
    "@modelcontextprotocol/node@>=2.0.0 <2.1.0": "2.1.1",
    "@hono/node-server@>=1.19.10 <2.1.3": "^2.1.3",
    "minimatch@>=10.0.0 <11.0.1": "^11.0.3"
  }
}
`;
export const EXPECTED_WORKSPACE_YAML = `# pnpm 11 refuses to install a package whose install script has no answer, so every package
# of the Agent Workspace runtime's dependency tree that ships one is answered here. The
# answers are copied from the Agent Workspace repository root.
allowBuilds:
  '@embedded-postgres/darwin-arm64': true
  '@embedded-postgres/darwin-x64': true
  '@embedded-postgres/linux-arm': true
  '@embedded-postgres/linux-arm64': true
  '@embedded-postgres/linux-ia32': true
  '@embedded-postgres/linux-ppc64': true
  '@embedded-postgres/linux-x64': true
  '@embedded-postgres/windows-x64': true
  'esbuild': false
  '@google/genai': false
  'protobufjs': false
# Security overrides of the runtime tree, also copied from the repository root.
overrides:
  'undici@>=7.0.0 <7.30.1': '^7.30.1'
  'undici@>=8.0.0 <8.12.2': '^8.12.2'
  'body-parser@>=2.0.0 <2.4.0': '^2.4.0'
  '@azure/msal-node@>=5.0.0-beta.0 <7.1.0': '^7.1.0'
  '@modelcontextprotocol/server@>=2.0.0 <2.3.0': '^2.3.0'
  '@modelcontextprotocol/client@>=2.0.0 <2.3.0': '^2.3.0'
  '@modelcontextprotocol/core@>=2.0.0 <2.3.0': '^2.3.0'
  '@modelcontextprotocol/node@>=2.0.0 <2.1.0': '2.1.1'
  '@hono/node-server@>=1.19.10 <2.1.3': '^2.1.3'
  'minimatch@>=10.0.0 <11.0.1': '^11.0.3'
`;
