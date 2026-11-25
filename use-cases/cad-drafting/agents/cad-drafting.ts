import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Drafting (DR), the rebuild of the gallery's drawing agent: it finds the past drawings (DXF, text)
// under `cad-drafting/` with `search_files` and reads them, then writes the new, unchecked drawing
// with the `cad-drafting` skill's script to `outputs/`, which the run returns. That render is the one
// write a person approves: `run_skill_script` waits, and is never auto-approved (ADR-0167 D5,
// #2388); only `search_files` runs unasked. The script's command line is office-reader's (ADR-0173),
// so the agent grants office-reader; office-writer is not needed, since the output is a DXF.
export default defineAgent({
  name: 'cad-drafting',
  instructions: { file: './cad-drafting.md' },
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('cad-drafting')],
  files: [files('cad-drafting', 'read')],
});
