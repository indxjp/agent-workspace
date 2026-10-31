---
changelog: aw
section: Fixed
---

- `aw agents export --format ts` (and the save in `aw agents new`) writes all of its files or none:
  a write that fails part-way removes the files already written, restores the ones `--force` was
  replacing, and names any path it could not put back; when it could not, it keeps the
  `.aw-export-*` directory that holds the only copy of the replaced files and names it. On a
  filesystem that cannot hard-link, or across devices, it copies instead. A process killed between
  two moves can still leave a partial export and that directory.
- A prompt on an input that has already ended (a closed pipe, Ctrl-D earlier) is an interrupt
  instead of waiting forever, and Ctrl-C typed while a run was streaming before an approval question
  now interrupts instead of being dropped with the typed-ahead keys.
