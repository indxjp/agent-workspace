import { defineBenchmark } from '../harness/benchmark.ts';

export default defineBenchmark({
  id: 'contract-review',
  order: 7,
  title: 'Contract review agent',
  cells: {
    agent: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'defineAgent with one skill, two read-only file grants and a page surface passes the server contract offline; no connector is needed.',
    },
    search: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the check finds every planted issue in the three drafts, each citing its playbook rule',
      note: 'Grounding is your playbook: Markdown rules in the file store plus a detector script that returns rule ids and standard clauses; nine rules need no retrieval.',
    },
    parse: {
      verdict: 'work',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'Word is parsed by the skill script `clauses.mjs`, which reads the `.docx` itself. The agent calls it through `run_skill_script`, a Node process with no shell that reads the granted folders and cannot write them, so it runs beside the read-only grants on `contracts` and `playbook`; the agent pre-approves `mcp__agent-workspace__run_skill_script` in `autoApprove`.',
    },
    struct: {
      verdict: 'gap',
      evidence: 'probe',
      ref: 'run-output-schema',
      note: 'The risk table comes back as Markdown in the answer; the backend parses it and reports unreadable rows instead of trusting a schema.',
    },
    hitl: {
      verdict: 'work',
      evidence: 'probe',
      ref: 'run-approval',
      note: 'Legal decides outside the run: the backend returns complete or incomplete with the missing must-flags, and your contract system records the decision.',
    },
    write: {
      verdict: 'gap',
      evidence: 'source',
      ref: 'apps/web/server/runs/launcher.ts',
      note: 'A redlined .docx the agent writes is not returned to the file store (persistPaths collects the wrong directory); the proposals come back in the answer, and your backend can build the .docx with writeDocx.',
    },
    trigger: null,
    scope: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (RF-102)',
      note: 'The `contracts` grant is per agent, not per person: everyone with the page reaches every draft in it, so keep one folder per deal team or one agent per team.',
    },
    ui: {
      verdict: 'work',
      evidence: 'probe',
      ref: 'surface-attachments',
      note: 'defineSurface publishes the legal-desk page, but it refuses attachments: legal uploads the draft in your app with `aw.files.upload` and names the file in the chat.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid, with a judge rubric for every must-flag',
      note: 'Six cases: each must-flag is pinned by its 〔PB-xx〕 with `contains` and judged by a rubric, plus a no-false-positive case and a no-verdict case.',
    },
    audit: {
      verdict: 'work',
      evidence: 'source',
      ref: 'docs/sdk/site/concepts/roadmap.mdx (N-1)',
      note: 'Runs record tokens and cost, but a skill has no revisions: keep the playbook in git and store its commit with each review to show which rules applied.',
    },
  },
});
