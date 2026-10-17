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
      note: 'defineAgent, a skill, a rules grant and a surface pass the contract; the policy ceiling makes the reviewer read-only by construction, so it cannot approve anything.',
    },
    search: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the archive finds precedents, including rejected ones, and refuses what it does not know',
      note: 'Precedents, rule clauses and the authority matrix are your own MCP server; check_authority is a deterministic table lookup the model copies rather than computes.',
    },
    parse: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-attachments',
      note: 'The quotes (見積書) attached to a ringi cannot be handed to a run; this example reviews the fields the workflow sends and leaves the quotes to a person.',
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'The review sheet comes back as Markdown; the backend parses the five fixed headings into typed findings and reports a dropped heading.',
    },
    hitl: null,
    write: {
      verdict: 'work',
      evidence: 'probe',
      ref: 'openapi-write',
      note: 'An openapiTool may only read, so your backend, not the agent, posts the comment to the workflow system and keeps it for a retry if the post fails.',
    },
    trigger: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'inbound-trigger',
      note: 'No inbound trigger and no idempotency key on runs.start (probe `run-start-idempotency`): you host the webhook and dedupe by ringi id and revision yourself.',
    },
    scope: {
      verdict: 'gap',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'Grants are per agent, not per approver: every approver sees every department’s precedents unless you split agents or archives by department.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'A side-panel surface lets approvers ask follow-up questions; `toolResults` cannot target this server’s tools, whose run names exceed 64 characters.',
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
