import { defineAgent, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'maintenance-troubleshooting',
  instructions: { file: './maintenance-troubleshooting.md' },
  model: 'default',
  engine: 'claude-agent-sdk',
  // No file, command or network permission: it reads and writes only through the two tools. The
  // one write it makes, a resolved case into the trouble log, goes through your MCP server, which
  // validates it; writeFiles stays off.
  permissions: {},
  tools: [mcp('trouble-log'), mcp('equipment-manual')],
  skills: [skill('one-step-diagnosis')],
  limits: { maxTurns: 10, maxBudgetUsd: 0.3 },
});
