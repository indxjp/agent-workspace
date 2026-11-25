---
changelog: platform
section: Fixed
---

- `run_skill_script` now creates each missing folder a script may write (the run's `outputs/` and
  the read-write directory grants, never a file grant, and nothing under a parent that resolves
  outside the run directory) before it starts the script. Node's permission model reads a write path that
  does not exist yet as a single file, so a script could create `outputs/` but write nothing in it:
  every approved `office-writer` render into a fresh session was refused with
  `output_not_writable` (R1 run 44985488322).
- The document drafting use cases `newcomer`, `work-instruction`, `privacy`, `interview`,
  `release-notes` and `announce` now always find their sources with `search_files` before reading
  them, and never pick a source by listing the folder (R1 run 44985488322 found no `search_files`
  call).
- A failed real-model verification record now names the code each failed call answered with, such
  as `run_skill_script!(output_not_writable)`, so a record tells why a call failed.
