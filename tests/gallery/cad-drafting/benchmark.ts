import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'cad-drafting',
  order: 2,
  title: 'CAD drawing agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineAgent with a read-only drawing grant, a read-write drafts grant, a skill with a script and a page surface pass the server contract offline.',
    },
    search: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the index ranks similar brackets by title block and size, reads a drawing whole, and lists DWG files it cannot read',
      note: 'Similar-drawing search is your MCP server: title-block text plus outline-size closeness, with the differences from the request on each candidate.',
    },
    parse: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'ASCII DXF is read and written by the skill’s Node script, which the agent calls through `run_skill_script`: no shell, read-only on the `drawings` grant, writing only where the agent may write. The agent pre-approves `mcp__agent-workspace__run_skill_script` and `Write` in `autoApprove`; DWG and scanned drawings cannot be read at all without a converter.',
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'The change set comes back as a json block inside the answer; the backend parses and validates every field itself.',
    },
    hitl: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-approval',
      note: 'A run cannot stop for the designer to pick a candidate, so the desk runs twice in one session; the final check (検図) happens outside the platform.',
    },
    write: {
      verdict: 'gap',
      evidence: 'source',
      ref: 'apps/web/server/runs/launcher.ts',
      note: 'A file the agent writes is not returned to the file store (no runtime profile sets `persistPaths` by default, and when one does it is collected from the runtime root `/workspace`, not the run directory), so the backend regenerates the DXF from the returned change set with the same script.',
    },
    trigger: null,
    scope: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'Grants are per agent, not per designer: customer-confidential drawings need a separate agent or a filter inside the index server.',
    },
    ui: {
      verdict: 'work',
      evidence: 'probe',
      ref: 'surface-attachments',
      note: 'defineSurface publishes the page-layout design desk, but a designer cannot attach a reference drawing there; it goes through `aw files upload` first.',
    },
    eval: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the eval file pins the candidates, the 未検図 mark and the refusals in text',
      note: '`aw eval` checks the answer text; that the geometry is exactly the requested size is not expressible there, so your own tests check the written DXF.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every run records tokens and cost; the audit log records who changed the agent and its policy.',
    },
  },
});
