import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'quotation',
  order: 3,
  title: 'Quotation agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineAgent, an openapiTool, a skill and a surface pass the server contract offline; the policy ceiling allows the ERP tool only.',
    },
    search: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the ERP tool admits exactly the three read operations and refuses a write rule',
      note: 'openapiTool turns the ERP’s read API into three tools with the credential kept in a secret; you write no server, only the OpenAPI document.',
    },
    parse: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: "The drawing is not read: sales enters its summary. The cost-model script runs because the agent declares `autoApprove: ['Bash', 'mcp__agent-workspace__run_skill_script']` in `defineAgent`, which `aw push` stores in the policy.",
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'The breakdown comes back as a fenced JSON block in free text; the backend extracts it, re-runs the cost model and refuses any number that differs.',
    },
    hitl: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-approval',
      note: 'A run cannot pause for approval, so every draft returns as pending and the approval queue lives in your sales system.',
    },
    write: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'openapi-write',
      note: 'openapiTool refuses POST, so the agent cannot book the quote; your backend books it in the ERP after a person approves.',
    },
    trigger: null,
    scope: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'ERP_TOKEN is the agent’s, not the salesperson’s: every user sees every customer’s past prices unless the ERP filters them.',
    },
    ui: {
      verdict: 'work',
      evidence: 'probe',
      ref: 'surface-attachments',
      note: 'defineSurface publishes the quote desk, but a surface takes no attachment: the drawing cannot be dropped in, only its summary typed.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Four cases (price, no past order, discount pressure, booking request) and a 0.9 promotion bar.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every run records tokens and cost; the backend keeps the run id with the draft, so an approved quote traces back to its run.',
    },
  },
});
