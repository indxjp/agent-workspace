import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'customer-inquiry',
  order: 5,
  title: 'Customer inquiry agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project and its embedded support widget pass the contract aw check applies',
      note: 'defineAgent with one openapiTool, a skill and a read grant on the FAQ folder, no write, command or network grant, passes the server contract offline.',
    },
    search: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the agent finds the history with openapiTool reads and the FAQ with search_files and ships no index server',
      note: 'The built-in `search_files` searches the FAQ and a read-only `openapiTool()` reads the customer’s history from the CRM; no connector and no index server of ours. The CRM API masks personal data in its own responses.',
    },
    parse: null,
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a mail parsed by the inbound-parse webhook starts a run whose reply the backend reads as typed output, once per Message-ID',
      note: 'The reply comes back typed (`runs.result` with a Zod schema); your backend still withholds a reply that repeats personal data.',
    },
    hitl: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend routes a run the agent handed to a person to the operator queue, from the agent.handoff frame',
      note: 'The agent has `engine.handoff` and calls `handoff_to_person({ reason })` for identity, refund and complaint; the run ends `completed` with an `agent.handoff` frame, and your backend routes the reason to its operator queue. No phrase is read out of the reply.',
    },
    write: null,
    trigger: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a mail parsed by the inbound-parse webhook starts a run whose reply the backend reads as typed output, once per Message-ID',
      note: 'A webhook trigger fed by the mail provider’s inbound-parse webhook starts one run per Message-ID with the reply as its `outputSchema`, and your handler reads the typed reply from the run id. A mail’s sender address proves nobody, so the run has no `subject`: the CRM refuses its history tools and this path answers from the FAQ.',
    },
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'refuses records of another customer by the asserted subject, not by prompt text',
      note: 'Your backend starts the run with `subject: customerId`, the CRM tool (`openapiTool()`) opts in with `identity`, and your CRM reads the customer from the signed assertion (`verifyIdentity`) and masks phone, address and e-mail; the hosted widget still cannot carry who is signed in, so the subject comes from your own backend.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project and its embedded support widget pass the contract aw check applies',
      note: 'defineSurface gives a dock widget for the company site with allowed origins, greeting, prompts, history, rating and a hidden tool trace.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Seven cases pin the FAQ answers, three handoffs and the refusal to disclose; thumbs-down ratings become cases with `aw eval add-case`.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every run records tokens and cost; the platform redacts nothing, so the CRM API masks personal data before the agent reads it, and what a customer types is kept as typed.',
    },
  },
});
