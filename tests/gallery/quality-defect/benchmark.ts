import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'quality-defect',
  order: 10,
  title: 'Quality defect and past-trouble analysis agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineAgent, the eight-d skill, an FMEA file grant and the qa surface pass the server contract offline.',
    },
    search: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the agent finds past cases through the QMS API and ships no MCP server',
      note: 'The cases live in the quality system, which the built-in `search_files` (files only) does not reach. The company QMS API is an `openapiTool()` (`tools/qms.ts`): `searchDefects`, `getDefect` and `causeStats` are reads scoped by the asserted subject, and `createCase` is the one write. The project ships no MCP server.',
    },
    parse: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the FMEA is an Excel workbook that office-reader reads back as fmea-workbook.ts has it (GALLERY_WRITE=1 regenerates it)',
      note: 'The press FMEA is the Excel sheet a quality department keeps, and the agent reads it with the built-in office-reader skill (`ooxml.mjs xlsx`) through `run_skill_script`, which the read-only grant on `fmea` allows.',
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend checks the structure a run returns, and a report with no structure fails the run',
      note: 'The 8D comes back with its D1–D8, whys and cited Q-numbers as typed fields (`runs.result` with a Zod schema); your backend runs the skill’s own checks on them and still checks every Q-number and 4M count against this run’s tool results.',
    },
    hitl: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend pauses on registering the case, and approving it registers the case under the same subject',
      note: 'The DR decides the one write, `createCase`, which is implicitly gated (a write admitted by `operationId:`), so the run pauses on it with the 8D in its arguments and `analyseDefect` answers with the draft after its checks. Approving continues the same session under the same `subject` and registers the case; rejecting with the DR’s comment sends it back and the revised 8D pauses again. An approval request expires after 24 hours and then ends the run, so a DR that decides later means running the analysis again.',
    },
    write: null,
    trigger: null,
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'refuses past cases of another process by the asserted subject, not by prompt text',
      note: 'The QA page starts each run with `subject: <who entered the defect>`, the QMS tool opts in with `identity`, and the QMS verifies the assertion (`verifyIdentity`) and searches, counts and reads only the processes that person may see, so the 4M counts in a draft are over what they may see. The policy ceiling (tested) still keeps the data inside with no egress, no file writes and only the `qms` tool.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: "defineSurface publishes the qa page with the full tool trace for the reviewer, and the similar cases render as a table with `toolResults: { searchDefects: 'table' }`.",
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Five cases, including a no-match case and a judged whys-depth rubric, behind a 0.9 promotion bar.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every run records tokens, cost and its tool calls, so a DR can see which past cases the draft was built from.',
    },
  },
});
