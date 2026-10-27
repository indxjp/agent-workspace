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
      ref: 'the ERP tool admits the three read operations and the one write, createQuote',
      note: 'openapiTool turns the ERP’s read API into three tools with the credential kept in a secret; you write no server, only the OpenAPI document.',
    },
    parse: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the drawing rides on the quote run as an attachment and the spec reaches the backend as the cost model input',
      note: "Sales attaches the drawing and the agent reads the part spec from it (`Read` takes PDF and images), passing it to the cost-model script; your backend reads that spec from the call, validates it and recomputes the price, so nobody types a spec summary. The cost-model script runs because the agent declares `engine: { autoApprove: ['Bash', 'mcp__agent-workspace__run_skill_script'] }` in `defineAgent`, which `aw push` stores in the policy; a run with an attachment has no shell, and `run_skill_script` is how the script still runs.",
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the booking run asks for a typed answer and the backend refuses a createQuote whose numbers the cost model does not give',
      note: 'The run closes with a typed answer (`runs.result` with a Zod schema), and the paused `createQuote` body is parsed with Zod; your backend re-runs the cost model and refuses any number that differs before anyone is asked to approve.',
    },
    hitl: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'draftQuote pauses on the checked createQuote and writes nothing; once approved the continuation books it for the asking salesperson',
      note: 'The run drafts and books in one go: `createQuote` is a gated write, so it ends `awaiting_approval` on that call and `draftQuote` answers the proposal (the call, the spec, the cost-model breakdown, the orders read and the confidence). `runs.approve` starts the continuation that books exactly that call; `runs.reject` with a comment sends it back and the revised call pauses again. No approval queue of your own.',
    },
    write: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a rejection with a comment sends the agent back and its revised createQuote pauses again, nothing booked',
      note: '`openapiTool` allows `operationId:createQuote`, and the engine holds it for approval: the ERP sees nothing until a person approves, one call per approval. The continuation keeps the paused run’s `subject` (ADR-0157), so the ERP records the quote for the salesperson who asked, not for the approver.',
    },
    trigger: null,
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'refuses past orders of another customer by the asserted subject, not by prompt text',
      note: "The quote desk starts each run with `subject: <signed-in salesperson>`, the ERP tool opts in with `identity`, and your ERP verifies the assertion (`verifyIdentity`) and lists and reads only that salesperson's customers' parts and orders; another customer's order is answered like one that does not exist. The rates are the same for everyone. ERP_TOKEN is still the agent's credential.",
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineSurface publishes the quote desk with `parts.attachments` on, so sales drops the drawing in and types the customer and quantity; the proposal waits until an approver confirms it.',
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
