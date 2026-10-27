import { defineAgent, files, skill } from '@indx-workspace/sdk/define';

import { maintenance } from '../tools/maintenance.ts';

export default defineAgent({
  name: 'maintenance-troubleshooting',
  instructions: { file: './maintenance-troubleshooting.md' },
  model: 'default',
  // A run is unattended: without autoApprove the SDK stops the search on an approval prompt.
  // `handoff` offers `handoff_to_person`: the agent passes the session to the expert with it.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    handoff: true,
  },
  // The past troubles, the experts' notes and the manuals are granted folders, searched with the
  // platform's `search_files` and opened with `Read`; the backend narrows each run to what the
  // signed-in technician may see (`runs.start({ fileScope })`). No write, command or network
  // permission: the one write it makes, a resolved case into the trouble log, is the maintenance
  // system's logResolution, which the platform runs only for a call the technician approved.
  permissions: { readFiles: true },
  tools: [maintenance],
  files: [files('trouble-log', 'read'), files('expert-notes', 'read'), files('manuals', 'read')],
  skills: [skill('one-step-diagnosis')],
  limits: { maxTurns: 10, maxBudgetUsd: 0.3 },
});
