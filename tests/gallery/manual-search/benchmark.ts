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
      note: 'defineAgent, a skill, a file grant and a surface pass the server contract offline; the policy ceiling keeps the agent read-only.',
    },
    search: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the index finds the clause, reads it whole, and finds nothing for an unrelated question',
      note: 'You host the index as an MCP server (about 100 lines here); the platform deliberately has no retrieval.',
    },
    parse: {
      verdict: 'work',
      evidence: 'source',
      ref: 'packages/core/src/db/schema/files.ts',
      note: 'Files are stored as bytes; PDF to page-marked text is your indexer’s job, done once per manual.',
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'Citations come back inside free text; the backend parses 〔…〕 and checks each against what the agent read.',
    },
    hitl: null,
    write: null,
    trigger: null,
    scope: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'Grants are per agent, not per person: split agents per department, or filter inside the index server.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineSurface publishes the side panel with suggested prompts, a collapsed tool trace and rating buttons; search hits cannot render as cards, because toolResults cannot name an MCP tool.',
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
