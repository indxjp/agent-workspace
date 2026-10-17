import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'meeting-minutes',
  order: 8,
  title: 'Meeting minutes & action-item agent',
  cells: {
    agent: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'The agent, skill, file grant and page surface pass the contract offline, and the agent calls the date script through `run_skill_script`, which runs beside the read-only grant on `transcripts` and is pre-approved in `autoApprove`.',
    },
    search: null,
    parse: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-attachments',
      note: 'A run that holds a read-only file grant has no shell, so the date script runs through `run_skill_script` instead. A run also takes no audio or attachments: transcribe in Teams or Zoom and pass the text in the prompt (up to 100,000 characters) or as a granted file.',
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'Action items come back inside the minutes; the backend reads a fenced `json action-items` block, falls back to the table, and refuses the draft when the two disagree.',
    },
    hitl: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the two-run flow registers exactly the approved items in the same session',
      note: 'A run cannot pause for approval (probe `run-approval`): run 1 drafts, the person approves in your UI, run 2 in the same session registers, and an approval token makes the tracker refuse anything else.',
    },
    write: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the tracker writes only approved items for roster members with real dates',
      note: 'openapiTool is read-only (probe `openapi-write`), so the tracker is your own MCP server that validates owner, date and approval before it writes.',
    },
    trigger: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'inbound-trigger',
      note: 'Nothing starts a run when a meeting ends; your backend listens for the transcript (Graph or Zoom webhook) and calls runs.start.',
    },
    scope: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'The tracker connector holds one credential per agent, so every task is created by the agent; record who approved it in your backend.',
    },
    ui: {
      verdict: 'work',
      evidence: 'probe',
      ref: 'surface-mcp-tool-results',
      note: 'defineSurface publishes a full-page minutes screen with history; the tracker tools cannot render as tables (`toolResults` cannot name an MCP tool), and the approval screen is your own.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Four cases pin resolved dates, 担当未定, no registration during a draft, and honorifics (judged), with a 0.9 promotion bar.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Both runs record tokens and cost under one session, and each create_task call is in the run’s event stream.',
    },
  },
});
