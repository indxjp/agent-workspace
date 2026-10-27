import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'manual-search',
  order: 1,
  title: 'Manual search agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineAgent, a skill, a file grant and a surface pass the server contract offline; the policy ceiling keeps the agent from writing files or reaching the network.',
    },
    search: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the agent finds the clause with search_files and ships no index server',
      note: 'Search is the platform’s built-in `search_files` over the granted `manuals` folder (PDF and Markdown), narrowed per caller with `runs.start({ fileScope })`; no index server or connector of your own.',
    },
    parse: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'office-reader pdf.mjs returns each manual page as the Markdown has it, under the page number printed on it',
      note: 'The manuals are PDF and the agent reads them with the built-in office-reader skill, then quotes the page it cites. `search_files` finds the page and the agent opens that PDF page; the page-marked Markdown copy is searchable too.',
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend asks for typed citations and checks every one against what search_files returned',
      note: 'The answer and its citations come back typed (`runs.result` with a Zod schema); your backend only checks each citation’s path and page against what `search_files` returned during the run.',
    },
    hitl: null,
    write: null,
    trigger: null,
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend scopes each run to the manuals the signed-in person may read, by fileScope and not by prompt text',
      note: 'The portal starts each run with `subject: <signed-in person>` and a `fileScope` of the manual paths (PDF and Markdown) that person may read, taken from its own access table. `search_files` and the sandbox cover only those paths, so the PDF the agent opens is scoped too; a person with no manual is refused before any run starts.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: "defineSurface publishes the side panel with suggested prompts, a collapsed tool trace and rating buttons; hits render as cards with `toolResults: { search_files: 'card' }`.",
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Four cases and a 0.9 promotion bar. Pin citations with `contains`, not `tool:`: a run names MCP tools `mcp__<connector-name>__…`, so a `tool:` pin holds only while the connector keeps that name.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every run records tokens and cost; the audit log records who changed the agent.',
    },
  },
});
