import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'ringi-review',
  order: 4,
  title: 'Ringi review agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineAgent, a skill, a rules grant and a surface pass the contract; the reviewer’s only write is a comment, and no tool it holds can approve or reject.',
    },
    search: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the agent finds precedents, including rejected ones, with search_files and ships no index server',
      note: 'Rule clauses and past ringi are files found with the built-in `search_files`, narrowed per caller with `runs.start({ fileScope })`; the model then opens the file it names. The one tool of ours left is `check_authority`, a deterministic table lookup the model copies rather than computes.',
    },
    parse: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the quotes (見積書) ride on the review run as attachments, and a ringi without quotes sends none',
      note: 'The quotes (見積書) are attached to the review run by file id and the agent reads each one, so no person transcribes a quote and no count field is kept.',
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'reviewRun reads the review sheet as typed output and flags a citation no tool returned',
      note: 'The sheet comes back typed (`runs.result` with a Zod schema), so a dropped heading fails the run instead of reading as no findings; your backend only checks the route and every citation against what the tools returned.',
    },
    hitl: null,
    write: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'postReview pauses on exactly the checked comment and, once approved, the continuation posts it for the filer',
      note: '`openapiTool` allows `operationId:postComment` only, so the agent can comment but not approve or reject. `postReview` starts a second run that posts exactly the checked comment with your warnings; it pauses for approval and answers the run id. `runs.approve` starts a continuation that posts that comment for the same filer (the platform keeps the paused run’s `subject`), and `runs.reject` posts nothing.',
    },
    trigger: null,
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'narrows each review run to the filer’s departments by fileScope, so another department’s precedents are never found',
      note: 'Precedents are stored as `ringi/<部門>/<year>.json`, so what a person may see is a set of paths. `startReview` computes `fileScope` from `data/access.json` (the permitted `ringi/<部門>` folders plus `rules`) and starts the run with it; `search_files` and the sandbox then hold nothing else (人事部 precedents stay with 人事部), and a filer who may read no department is refused before any run starts.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: "A side-panel surface lets approvers ask follow-up questions; search hits render as cards with `toolResults: { search_files: 'card' }`.",
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Four cases pin the route, the clauses, a rejected precedent and that the sheet never recommends approval, with a 0.9 promotion bar.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every review run records tokens and cost, and the audit log records who changed the agent or its rules skill.',
    },
  },
});
