import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'meeting-minutes',
  order: 8,
  title: 'Meeting minutes & action-item agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'The agent, skill, file grant and page surface pass the contract offline, and the agent calls the date script through `run_skill_script`, which runs beside the read-only grant on `transcripts` and is pre-approved in `autoApprove`.',
    },
    search: null,
    parse: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'apps/web/server/runs/transcription.ts',
      note: 'A run takes workspace files as attachments, and an attached recording is transcribed into the turn on an OpenAI connection; other providers refuse with `run_attachments_untranscribable`. A .txt or .vtt transcript is read as it is.',
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the draft reads action items as typed output and still refuses an impossible due date or a missing heading',
      note: 'Run 1 returns the minutes and the action items typed (`runs.result` with a Zod schema); your backend only checks the minutes format and that each due date is a real day.',
    },
    hitl: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'each action item pauses on its own createTask and writes nothing; once approved the continuation creates it under the asking clerk and the next item is offered',
      note: 'Run 1 drafts; then `registerItems` starts one run per item that has an owner and a real date, and each pauses on its `createTask`. `decideTask` calls `runs.approve` (the continuation creates the task) or `runs.reject` (it creates nothing) and offers the next item. The engine allows one gated call per approval, so one item is one run. No approval queue of your own.',
    },
    write: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a rejection skips the item: its continuation creates nothing and the next item is offered',
      note: '`openapiTool` allows `operationId:createTask`, and the tracker keeps its owner, department, date and duplicate rules. The tracker sees nothing until a person approves that call, and the continuation keeps the paused run’s `subject` (ADR-0157), so each task is recorded for the clerk who asked, not the approver.',
    },
    trigger: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a Graph transcript notification starts the typed draft run, and a duplicate starts nothing',
      note: 'A webhook trigger fed by the Graph subscription starts one run per notification with the minutes and action items as its `outputSchema`, and names the clerk as its `subject` (ADR-0156), so the tracker, which scopes by caller, accepts the run; the backend reads it (`draftMinutesFromRun`), dates the meeting from the minutes and checks the draft before anyone approves it.',
    },
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'refuses members and tasks of another department by the asserted subject, not by prompt text',
      note: 'The backend starts every run with `subject: <who ran the meeting>`, the tracker connector opts in with `identity`, and your server verifies the assertion (`verifyIdentity`), lists and assigns only the departments that person covers, and records who created each task. Every write waits for approval, and the continuation acts for the same person.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: "defineSurface publishes a full-page minutes screen with history that renders the tracker’s tasks as a table (`toolResults: { list_tasks: 'table' }`); the approval screen is your own, driven by `decideTask`.",
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
      note: 'Both runs record tokens and cost under one session, and each createTask call is in the run’s event stream.',
    },
  },
});
