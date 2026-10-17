import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'maintenance-troubleshooting',
  order: 9,
  title: 'Skill-transfer & maintenance troubleshooting agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineAgent with two MCP tools, a skill and no file, command or network permission passes the server contract offline.',
    },
    search: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the trouble log finds the machine own history first, then the same model, and nothing for an unrelated symptom',
      note: 'Past troubles and expert notes are searched by your own MCP server (same machine first, then same model); the manuals reuse use case 1’s index server.',
    },
    parse: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'surface-attachments',
      note: 'The technician cannot photograph the faulty part: a surface takes no attachments, and `runs.start` takes none either (probe `run-attachments`).',
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'Steps, citations and the escalation come back as free text; the backend parses 手順N： and 〔…〕 on every turn and flags what breaks the rules.',
    },
    hitl: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'after the known causes the session escalates to the expert and takes no more steps',
      note: 'No run event hands the case to a person (probe `run-handoff`): the backend detects the escalation phrase or its own step limit, closes the session and notifies the expert.',
    },
    write: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'a three-turn diagnosis ends resolved and the resolution is written to the trouble log',
      note: 'Logging the fix takes your own MCP tool that validates and writes the record: `openapiTool` is GET-only and a file the agent writes is not returned to the store.',
    },
    trigger: null,
    scope: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'Runs carry no end-user identity for tools: the backend names the signed-in technician in the prompt and checks the log records the same person.',
    },
    ui: {
      verdict: 'gap',
      evidence: 'source',
      ref: 'apps/web/app/p/s/[name]/page.tsx',
      note: 'The `floor` page surface (hidden tool trace, ratings) passes the contract, but it is rendered per request and every turn is a server run: no offline mode for dead spots on the floor.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid',
      note: 'Four cases and a 0.9 bar; an expert’s thumbs-down with a correction is run feedback that `aw eval add-case` turns into a new case.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every turn is a run with tokens and cost; the trouble log itself records who fixed what and when.',
    },
  },
});
