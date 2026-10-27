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
      note: 'defineAgent with the built-in `office-reader` skill and one of its own, two read-only file grants, one read-write scratch grant and a page surface passes the server contract offline; no connector is needed.',
    },
    search: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the agent finds the playbook rule with search_files and ships no index server',
      note: 'The nine playbook rules are Markdown files found with the platform’s search_files over the granted `playbook` folder; applying them stays a detector script (`clauses.mjs check`) that returns rule ids and standard clauses, because that is a deterministic check, not retrieval.',
    },
    parse: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'clauses.mjs redline plus office-reader write the draft with a 【修正案】 paragraph per must-flag finding',
      note: 'The agent reads the Word draft with the built-in `office-reader` skill (`ooxml.mjs docx <file> drafts/<name>.json`, which saves the paragraphs itself), and runs the playbook script `clauses.mjs` on that JSON; the script opens no `.docx` and refuses one by name. `clauses.mjs redline` prints the redlined paragraphs, the agent `Write`s them, and once legal approves, `office-reader` (`ooxml.mjs write`) makes the Word file in `outputs/`. The agent pre-approves `mcp__agent-workspace__run_skill_script` in `autoApprove`; the redline’s `Write` is the one gated call.',
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend reads the rows as typed output after legal approves, and returns the review when they cover every must-flag finding',
      note: 'The risk rows come back typed (`runs.result` with a Zod schema, kept by the approval continuation), next to the Markdown legal reads; your backend only compares them with the deterministic check and refuses a review that leaves out a must-flag finding.',
    },
    hitl: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend pauses on the redline before the Word is made, and approving it returns the rows and the .docx',
      note: 'The redline’s `Write` is gated (`requireApproval`), so the run pauses on it and no Word file exists yet; `reviewContract` answers with the redline paragraphs legal reads. Approving continues the same session, makes the `.docx` and returns the typed rows; rejecting with a comment sends the redline back and the revised one pauses again. An approval request expires after 24 hours and then ends the run, so a decision that waits longer than that means starting the review again.',
    },
    write: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend returns the redlined .docx the agent wrote',
      note: 'The agent’s redlined .docx comes back with the approved run (`runs.outputs`); the backend checks it carries a 【修正案】 for every must-flag finding and builds no Word file itself.',
    },
    trigger: null,
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a reviewer reaches only the contracts of their deal teams, by fileScope and not by prompt text',
      note: 'Contracts live at `contracts/<deal-team>/<file>.docx`. The legal desk starts each run with `subject: <signed-in reviewer>` and `fileScope` = the `contracts/<team>` folders `access.json` gives that member, plus `playbook` and the scratch folder `drafts/<team>`, so `search_files` and the run’s files cover only those paths; a member with no team, or an attachment that is not one of the session’s uploads under their teams, is refused before any run starts. The agent’s own grants (the contracts and playbook it reads, the drafts it writes) are still granted per agent.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the draft rides on the review run as an attachment; the prompt names the working folder, not the draft',
      note: 'defineSurface publishes the legal-desk page with `parts.attachments` on, so legal drops the draft in; your app passes its file id to `runs.start` and the agent reads the attached path, so nobody uploads first and names the file in the chat.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file and the promotion bar are valid, with a judge rubric for every must-flag',
      note: 'Six cases: each must-flag is pinned by its 〔PB-xx〕 with `contains` and judged by a rubric, plus a no-false-positive case and a no-verdict case.',
    },
    audit: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a review run names the version, and the version pins the playbook revision the review applied',
      note: "The agent pins `skill('contract-playbook', { revision: 1 })`, published with `aw skills publish`. A review’s run reports `agentVersion`, `agents.versions.list` gives that version’s `resources.skillRevisions`, and `skills.get` lists the revision’s number, file count and date. Reading a revision’s bytes back is not offered, so the trail ends at that metadata.",
    },
  },
});
