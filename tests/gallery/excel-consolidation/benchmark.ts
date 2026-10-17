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
      note: 'defineAgent with two skills (one shared), an MCP tool and a surface passes the server contract offline; the policy ceiling allows commands but not the Write tool.',
    },
    search: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'find_files finds both months of every branch by name and refuses a folder outside the root',
      note: 'Finding workbooks on SharePoint, Box or a file server is your MCP server (about 80 lines here, with the path-traversal check); the platform searches nothing.',
    },
    parse: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: "Files are bytes (up to 64 MiB each); the skill scripts parse xlsx and apply the plan, and the agent declares `autoApprove: ['Bash']` in `defineAgent` so an unattended run can call them.",
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'The plan and the report come back as a fenced JSON block inside the answer text; the backend parses and validates both.',
    },
    hitl: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the backend shows a validated plan, then continues the session and accepts a grounded explanation',
      note: 'A run cannot pause for approval (probe `run-approval`), so the confirmation is two runs in one session: plan, then the confirmed plan as the next prompt.',
    },
    write: {
      verdict: 'gap',
      evidence: 'source',
      ref: 'apps/web/server/runs/launcher.ts',
      note: 'A consolidated workbook the agent writes is not returned to the file store (persistPaths collects the wrong directory); the report travels in the answer instead.',
    },
    trigger: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'inbound-trigger',
      note: 'Nothing starts the monthly run on a schedule or when the last branch uploads; your own cron calls the backend.',
    },
    scope: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'Grants are per agent, not per person: a branch manager using this agent sees every branch, unless your file server filters by caller.',
    },
    ui: {
      verdict: 'work',
      evidence: 'probe',
      ref: 'surface-mcp-tool-results',
      note: 'defineSurface publishes the planning page, but the file list cannot render as a table: `toolResults` must name the run’s tool exactly, and that name carries a per-workspace connector id.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Three cases pin the plan (units, the excluded template, no premature totals); an eval is one prompt, so turn 2 is checked by the backend, not by evals.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every run records tokens and cost; every consolidated value also carries its `file!sheet!cell`.',
    },
  },
});
