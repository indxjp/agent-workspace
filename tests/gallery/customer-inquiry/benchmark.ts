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
      note: 'defineAgent with one MCP tool and a skill, no file, command or network grant, passes the server contract offline.',
    },
    search: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the CRM server finds the history of the signed-in customer, masked, and the FAQ',
      note: 'History and FAQ search is your own MCP server (about 190 lines, plus 95 for masking); the platform has no retrieval.',
    },
    parse: null,
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'The handoff reason comes back as a 〔引継ぎ: …〕 tag in free text, which the backend parses and strips.',
    },
    hitl: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-handoff',
      note: 'No run event hands the chat to a person: the backend spots 「担当者におつなぎします」 and routes it to your operator queue itself.',
    },
    write: null,
    trigger: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'inbound-trigger',
      note: 'Inquiries arriving by e-mail cannot start a run; your mail handler must call `runs.start` itself.',
    },
    scope: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the CRM server refuses records of another customer and forged or expired tokens',
      note: 'Connector credentials are per agent (RF-102), so a backend-minted HMAC token in the prompt, checked by your server, scopes each customer, and your server masks phone, address and e-mail; the hosted widget cannot carry who is signed in.',
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
      note: 'Every run records tokens and cost; the platform redacts nothing, so your server masks CRM data before the agent reads it, and what a customer types is kept as typed.',
    },
  },
});
