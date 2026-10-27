import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'excel-consolidation',
  order: 6,
  title: 'Excel consolidation & analysis agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineAgent with two skills (one shared), read grants on the branch folders and a surface passes the server contract offline; the policy ceiling allows `run_skill_script` and writing the workbook to `outputs/`.',
    },
    search: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the agent finds the workbooks with search_files and ships no index server',
      note: 'The built-in `search_files` finds the workbooks by the text inside them (sheet names, headers, categories) over the granted branch folders, narrowed per caller with `runs.start({ fileScope })`; no connector and no index server of ours.',
    },
    parse: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the script consolidates five layouts with exact totals and a source cell for every value',
      note: 'The skill script `consolidate.mjs` reads the workbooks itself with `scripts/xlsx.mjs`, a copy of the built-in office-reader reader that a test pins to the original, and applies the confirmed plan (units, 和暦, Excel serials). The agent runs it through `run_skill_script`, pre-approved in `autoApprove`, beside the read-only grants (no shell); office-reader writes the workbook to `outputs/`.',
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend reads the plan from the paused Write, the report as typed output once it is approved, and accepts a grounded explanation',
      note: 'The report comes back typed (`runs.result` with a Zod schema) and the plan is read from the `Write` the run is paused on; your backend only checks the plan against the workbooks found, recomputes every total and refuses numbers the script did not produce.',
    },
    hitl: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend reads the plan from the paused Write, the report as typed output once it is approved, and accepts a grounded explanation',
      note: "The agent saves its mapping plan with `Write`, which `requireApproval: ['Write']` holds: the run is `awaiting_approval` until a person approves (`runs.approve`) or rejects with a comment (`runs.reject`, and the revised plan pauses again). The approval admits exactly the plan that was shown.",
    },
    write: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend returns the consolidated workbook the agent wrote',
      note: 'The agent’s consolidated workbook comes back with the run (`runs.outputs`); the backend checks it against the report that adds up and builds no workbook itself.',
    },
    trigger: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the monthly schedule trigger starts the plan run when it is due, as the planner it names',
      note: 'A schedule trigger starts the monthly run on time, asks it for the report as its `outputSchema`, and names the planner as its `subject` (ADR-0156). A trigger cannot carry a `fileScope`, so the run searches every granted branch folder; the backend reads the plan from the run paused on its `Write` (`proposePlanFromRun`), refuses a plan naming a file outside the planner’s folders, and validates it before anyone approves it.',
    },
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'each person gets a fileScope of the branch folders they may see, and a person with none is refused before any run',
      note: 'The planning desk starts each run with `subject: <signed-in person>` and a `fileScope` of the branch folders that person may see (from `data/access.json`), so `search_files` and the hydrated workbooks cover only those paths; a person with no folder is refused before any run starts. The files the agent writes are still granted per agent, not per person (P2-4).',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineSurface publishes the planning page, and the plan is confirmed in the page.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Three cases pin the plan (units, the excluded template, no premature totals) and score at the approval pause (`awaitsApproval`); the eval never approves, and the runner cancels the paused run. What follows the approval is checked by the backend.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every run records tokens and cost; every consolidated value also carries its `file!sheet!cell`.',
    },
  },
});
