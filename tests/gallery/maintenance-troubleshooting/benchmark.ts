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
      note: 'defineAgent with one MCP tool (the write-back), three read-only file grants, a skill and no write, command or network permission passes the server contract offline.',
    },
    search: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'search_files finds the machine own history, the experts notes and the manual, and nothing for an unrelated symptom',
      note: 'Past troubles, expert notes and manuals are granted folders searched with the built-in `search_files`, narrowed per technician with `runs.start({ fileScope })`; each file carries the 〔…〕 source the agent copies, and the agent opens the file with `Read`.',
    },
    parse: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a photo of the part rides on the turn as an attachment, and a text-only turn sends none',
      note: 'The `floor` page turns on `parts.attachments`, so the technician photographs the faulty part and the backend passes its file id to `runs.start`; the agent reads the photo with `Read`, and the run has no shell while a photo is attached.',
    },
    struct: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'a three-turn diagnosis reads each turn as typed output, ends resolved and the approved logResolution call writes the resolution',
      note: 'Each turn comes back typed (kind, step, sources; `runs.result` with a Zod schema); your backend still checks safety first, the step order, that every source was returned by a tool in that run, and that a resolution was logged.',
    },
    hitl: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'after the known causes the agent hands the session to the expert, from the agent.handoff frame, and it takes no more steps',
      note: 'The agent has `engine.handoff` and calls `handoff_to_person({ reason })` when the known causes are exhausted; the run ends `completed` with an `agent.handoff` frame, and your backend closes the session and notifies the expert. The backend still ends a session by itself past its step limit.',
    },
    write: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the desk pauses on the logResolution call and, once the technician approves, the continuation logs the resolution for them and resolves the session',
      note: "The maintenance system's `POST /resolutions` is an `openapiTool()` that admits `logResolution`, recorded as the signed-in technician and `reviewed: false`. The run pauses on the call and the desk answers the run id; `runs.approve` starts a continuation that logs it for the same technician (the platform keeps the paused run’s `subject`), and the session is resolved only when that call succeeded. A rejection logs nothing and hands the session to the expert.",
    },
    trigger: null,
    scope: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'each technician searches only the folders access.json names for them, and one with nothing to see is refused before any run',
      note: 'The backend turns `data/access.json` into a path-based `fileScope` (`trouble-log/<line>`, `expert-notes/<group>`, the technician’s manuals) on `runs.start`, so `search_files` and the sandbox cover only those, and a technician with nothing accessible is refused before a run starts. The trouble-log write-back opts in with `identity`, verifies the signed `subject` and records that name.',
    },
    ui: {
      verdict: 'ok',
      evidence: 'contract',
      ref: 'the project passes the contract aw check applies',
      note: 'The `floor` page surface (hidden tool trace, ratings) passes the contract; every turn is a server run, so plan network coverage at the press, and set allowedOrigins to serve it beyond loopback.',
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
