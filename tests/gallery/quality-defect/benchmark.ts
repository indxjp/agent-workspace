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
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/guides/tools-from-code.mdx',
      note: 'The quality DB cannot be queried directly (the postgresTool gate is closed, #598), so you export past cases and serve them from your own MCP server with search, full reports and 4M counts.',
    },
    parse: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'The skill script that checks the 8D draft runs through `run_skill_script`, a Node process with no shell that cannot write the granted folders, so it runs beside the read-only grant on `fmea`; the agent does not call it during a run and pre-approves `mcp__agent-workspace__run_skill_script` in `autoApprove` only for a manual check.',
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'The 8D comes back as Markdown; the backend parses D1–D8 and the whys with the skill’s own parser and checks every Q-number and 4M count against this run’s tool results.',
    },
    hitl: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'a DR comment goes back as a follow-up turn and the revised draft is checked again',
      note: 'The DR is a meeting after the run, so nothing pauses: the backend gates the agenda on the checks, and the reviewer’s comment returns as a turn with the same sessionId.',
    },
    write: null,
    trigger: null,
    scope: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'Access is per agent, not per person: that suits one QA department sharing an archive, and the policy ceiling (tested) keeps the data inside with no egress, no file writes and only the defect-db connector.',
    },
    ui: {
      verdict: 'work',
      evidence: 'probe',
      ref: 'surface-mcp-tool-results',
      note: 'defineSurface publishes the qa page with the full tool trace for the reviewer; the similar cases cannot render as a table, because `toolResults` cannot name an MCP tool.',
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
