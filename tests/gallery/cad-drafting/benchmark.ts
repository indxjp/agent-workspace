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
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the agent finds similar drawings with search_files and ships no index server',
      note: 'Similar drawings are found with the built-in `search_files`, narrowed per designer with `runs.start({ fileScope })`; no index server or connector is needed. The platform reads each DXF’s title block (part name, material, thickness, notes) itself, so a search for the part name lists the candidates, and the agent reads the closest with `office-reader` to work out the differences in outline and material. DWG and scanned drawings cannot be searched.',
    },
    parse: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the skill script drafts a DXF that re-parses with exactly the requested geometry',
      note: 'The agent reads the base drawing with the built-in `office-reader` skill (`dxf.mjs`: layers, lines, circles, text) through `run_skill_script`, and the use case’s own script only derives and writes the new DXF from that JSON; it has no DXF reader of its own. The agent pre-approves `mcp__agent-workspace__run_skill_script` in `autoApprove`; it saves the base JSON with the script itself, not with `Write`, so the change set’s `Write` is the one call a designer approves. An entity office-reader reads no coordinates for (an arc, a polyline, a block) is refused by name, never dropped; DWG and scanned drawings cannot be read at all without a converter.',
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend validates the change set in the paused Write and refuses one that invents a dimension before anyone approves it',
      note: 'The change set is the content of the paused `Write`, untrusted JSON until your backend parses it with a Zod schema; it then checks it against the requirements, the base drawing and, after approval, the DXF the agent wrote.',
    },
    hitl: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend pauses on the change set before anything is drawn, and drafts it once approved, marked 未検図',
      note: 'The change set’s `Write` is gated (`requireApproval`), so the run pauses on it and nothing is drafted. Approving continues the same session and drafts; rejecting with a comment such as “BRK-1004 を元に” sends it back and the revised change set pauses again. The final check (検図) still happens outside the platform.',
    },
    write: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the backend returns the DXF the agent wrote, not one it regenerates',
      note: 'The agent’s DXF comes back with the run (`runs.outputs`); the backend checks it and writes nothing itself.',
    },
    trigger: null,
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a designer reaches only the drawing series access.json gives them, by fileScope and not by prompt text',
      note: 'Drawings live at `drawings/<series>/<number>.dxf`. The design desk starts each run with `subject: <signed-in designer>` and `fileScope` = the `drawings/<series>` folders `access.json` gives that designer, so `search_files` and the run’s files cover only those paths; a designer with no series is refused before any run starts. The agent’s own grants (the drawings folder it reads, the drafts it writes) are still granted per agent.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a reference drawing rides on the proposal run as an attachment, and none is sent without one',
      note: 'defineSurface publishes the page-layout design desk with `parts.attachments` on, so a designer attaches a reference drawing; your app passes its file id to `proposeDraft`, which sends it with the run.',
    },
    eval: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the eval file pins the candidates, the 未検図 mark, the refusals and the change-set geometry',
      note: "`aw eval` checks the answer text and, with `expect.output`, the change set's outline as structured output.",
    },
    audit: {
      verdict: 'ok',
      evidence: 'source',
      ref: 'packages/contracts/src/runs.ts (usage, cost); packages/sdk/src/resources/observability.ts',
      note: 'Every run records tokens and cost; the audit log records who changed the agent and its policy.',
    },
  },
});
