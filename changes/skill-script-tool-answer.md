---
changelog: platform
section: Added
---

- `run_skill_script` can hand a script the answer of an earlier tool call of the same run: the model
  passes `input: { fromToolUse: "<tool call id>" }`, and the engine writes that answer, exactly as
  the model received it, to a file the script can read and cannot change, named in
  `SKILL_SCRIPT_INPUT`. The model no longer copies a tool's records into the arguments, where it
  could alter them and where 8 KiB was the limit. An id the run received no answer to, an error
  answer and an answer over 2 MiB are refused. A continuation of an approval also holds the answers
  of the session it resumes, so an approved call runs on the answer its approved id names. A
  subagent's answers are never handed to a script. The same on every engine that offers the tool
  (ADR-0176).
- A skill script can import the built-in public-source reader,
  `@indx-workspace/builtin-skills/office-reader/scripts/lib/public-source.mjs`. It returns the
  answer's `asOf` and its records as `{ id, ...fields }`, and refuses an answer that is not the
  public-source tool's, a cut one (`truncated: true`), a record without an id and a repeated id.
