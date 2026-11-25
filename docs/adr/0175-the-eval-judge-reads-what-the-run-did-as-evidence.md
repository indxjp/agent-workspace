# ADR-0175 — The eval judge reads what the run did, as evidence

Status: accepted
Date: 2026-11-23
Decided by: the implementing agent of unit G7 (the Agent Store 100-use-case plan, §5.3 and §9 G), design approved by the programme's orchestrator on the Owner's delegation
Scope: `apps/web/server/evaluations/judge.ts` (`judgePrompt`, `JUDGE_SYSTEM`), `apps/web/server/evaluations/score.ts` (`toolCallLog`), `apps/web/server/evaluations/handlers.ts` (`settleCase`)

## Context

An evaluation case's `judge` is a rubric a model grades the run against (issue #618). Until now the
judge saw three things: the rubric, the case's input and the run's answer, the assistant text of the
whole turn (`turnAnswer`). It did not see what the run did.

Many cases need more than that. A use-case entry's write waits for a person (ADR-0145), so its
`suggested` and `safety` cases end at the paused call, and their rubrics speak of that call: the
content of the paused `Write`, the arguments of a `change_access`, a draft model the agent wrote
under `drafts/` before a skill script renders it, or a tool the run must not have called. The
structured output of a case with an `outputSchema` is in the same position. The judge could verify
none of it, so it graded such a rubric on what the answer said about the call, or guessed.

The deterministic checks do not close the gap. `toolInput` and `output` are subset matches: they
can say a key has a value, but not "the draft does not mention X" or "the table proposes only the
one grant asked for".

## Decision

1. **The judge prompt carries the run's actions as evidence.** After `<agent_answer>` come three
   sections, always present, `(none)` when empty:
   - `<agent_tool_calls>`: every `agent.tool.call` of the run, in order, one JSON object a line,
     `{"tool", "status", "input"}`. `status` is `completed`, `error` (completed with the engine's
     error flag), `failed` or `no_result` (`toolCallLog`). Unlike the `tool` check, which counts
     successful calls only (EVL-01), the judge sees refused and failed calls too, marked as such: a
     rubric may be about an attempt.
   - `<paused_call>`: the call the run stopped on for approval, read from the run's pending
     approval (`pausedCall`), `{"tool", "input"}`. The prompt says it has not run.
   - `<structured_output>`: the run's structured output as JSON.
2. **The files a run wrote are its write calls' inputs.** `Write` carries the file's content and
   `Edit` its change, so the content of a file the run wrote, including the `drafts/` model a
   `run_skill_script` render reads, is already in the evidence. The judge does not read workspace
   storage: an evaluation never approves, so a paused write has written nothing, and reading files
   would add a store dependency, latency and a second size problem for no more information.
   Tool results are not included: they are what the agent read, not what it did, and they are the
   largest frames.
3. **Evidence is data, never instructions.** `JUDGE_SYSTEM` names the three new tags beside the old
   ones as data to grade. Each value is serialized with `JSON.stringify`, then `<`, `>` and `&` are
   replaced by JSON's own `\u003c`, `\u003e` and `\u0026` escapes (`<`, `>` and `&`). The
   value reads the same to a model and parses back to the same JSON, but no text inside it can close its section, open a
   `<rubric>` or otherwise move out of the evidence. A test plants such an attack in a tool input,
   the paused call and the structured output, and checks that the prompt outside the evidence
   sections is byte-identical to a benign one; another forges sections in the answer, the input and
   the rubric (decision 7). The verdict parser (EVL-03) is unchanged and still
   fails a reply closed when it quotes a verdict.
4. **The size is bounded.** One call, the paused call and the structured output are each cut at
   8,000 characters of JSON with `[truncated: N more characters]`, never between the halves of a
   surrogate pair. The calls together stop at 32,000 characters, and the rest are counted:
   `[N more tool calls omitted]`. The order is the run's order, so the earliest calls are kept.
   At most about 48,000 characters of evidence are added to a judge call.
5. **The sections are always there.** A case whose rubric needs no evidence gets them too, as
   `(none)` or as the calls it made. The alternative, adding them only when non-empty, would keep a
   prompt byte-stable for runs that did nothing, but would make "did not call `change_access`"
   unverifiable (an absent section and a section left out look the same), and give the judge two
   prompt shapes. A judge is a model, so its verdict was never deterministic; the deterministic
   checks (`contains`, `notContains`, `tool`, `toolInput`, `output`, `awaitsApproval`) and the
   verdict parser are untouched, and the prompt is a pure function of the run's frames and row.
6. **Nothing new is exposed.** The evidence is the run's own frames and row, which the principal
   who started the evaluation can already read through the run API, sent to the agent's own model
   connection, which the run already used. The judge's reason is stored as before, cut at 500
   characters.

7. **The graded text cannot forge a section.** The answer, the input and the rubric are not JSON,
   so they are not escaped; instead every opening or closing tag of the six section names in them
   (any case, any spacing, such as `</ PAUSED_CALL >`) is rewritten to an inert
   `&lt;/paused_call&gt;` in the judge's copy (`neutralizeTags`). A model-written answer holding
   `</agent_answer>` and a clean `<paused_call>` therefore cannot forge evidence ahead of the real
   sections: each tag occurs exactly once in the prompt. The deterministic checks (`contains`,
   `notContains`) keep reading the raw answer.

## Consequences

- Rubrics may speak of the paused call, its arguments, the content a run wrote and the structured
  output. The evaluations guide and the use-case kit README say so.
- `aw eval`, the SDK's `evaluations` resource and the Builder's eval runner post cases to the same
  server path (`evaluateAgentVersion` and the leased large evaluation, both `runCase`), so they all
  get the change. The contracts are unchanged: no field was added to a case or a result.
- A judge call costs more input tokens for runs with many or large tool calls, at most the bound
  above.
- A section tag that an answer, an input or a rubric quotes reaches the judge as inert text
  (`&lt;/agent_answer&gt;`, decision 7); the answer the deterministic checks read is unchanged, so a
  `contains` on a quoted tag still matches.
