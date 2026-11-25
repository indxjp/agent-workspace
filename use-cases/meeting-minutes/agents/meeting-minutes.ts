import { builtinSkill, defineAgent, files, skill } from '@indx-workspace/sdk/define';

// Scheduled report (RP), the rebuild of the gallery's minutes agent. Started by the trigger in
// `triggers/meeting-minutes.json` (ADR-0144, ADR-0154) or asked in chat, it reads the transcripts
// and the member list in its own folder, `meeting-minutes`, and saves the minutes under its own
// `meeting-minutes-reports` with the `meeting-minutes` skill's script, which turns every deadline
// said in words into a date. That save is the one call a person approves: `run_skill_script` waits,
// and is never auto-approved while a grant is read-write (ADR-0167 D5). The script's command line is
// office-reader's (ADR-0173), so the agent grants office-reader.
export default defineAgent({
  name: 'meeting-minutes',
  instructions: { file: './meeting-minutes.md' },
  engine: {
    id: 'claude-agent-sdk',
    autoApprove: ['mcp__agent-workspace__search_files'],
    requireApproval: ['mcp__agent-workspace__run_skill_script'],
  },
  permissions: { readFiles: true, writeFiles: true, runCommands: true },
  skills: [builtinSkill('office-reader'), skill('meeting-minutes')],
  files: [files('meeting-minutes', 'read'), files('meeting-minutes-reports', 'read-write')],
});
