import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

import { qms } from '../tools/qms.ts';

export default defineAgent({
  name: 'quality-defect',
  instructions: { file: './quality-defect.md' },
  model: 'default',
  // A run is unattended: the agent runs office-reader on the FMEA workbook without a prompt. It
  // does not run the eight-d check script itself; that is the backend's, and a manual check only.
  // The 8D ends (D8) by registering the case as a 過去トラ, and the DR decides that: `createCase` is
  // the QMS tool's one write, so it is implicitly gated (ADR-0145) and the run waits there for an
  // approval; nothing is registered before. Every other tool is a read.
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__run_skill_script'],
  },
  // Reads the FMEA workbook (.xlsx) with office-reader; runCommands offers run_skill_script for
  // that. No file writes, no network (the project ceiling forbids both whatever this file says);
  // `createCase` is a QMS write, not a file write.
  permissions: { readFiles: true, runCommands: true, unrestrictedNetwork: false },
  tools: [qms],
  skills: [builtinSkill('office-reader'), skill('eight-d')],
  files: [files('fmea', 'read')],
  limits: { maxTurns: 16, maxBudgetUsd: 1 },
});
