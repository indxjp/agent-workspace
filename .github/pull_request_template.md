<!--
REQUIRED FAIL-FAST CONTRACT: CI parses exactly one "## Ownership" section before it runs builds
or tests. Keep "Owns globs:" on one physical line, replace every placeholder, and make the diff a
subset of those globs. A missing or malformed declaration fails the first CI phase.
-->

## Ownership

Owns globs: <comma-separated globs from the task card or explicitly approved cleanup scope>
Files touched outside Owns: none

## Summary

<What changed and why, in a few sentences.>

## How it was tested

```
<the exact commands run, and their output>
```

## Declared gaps

<REQUIRED. One line per approximation, unverified assumption, deferred case, or
place where the spec was ambiguous and a reading was chosen. Write "None." only
if you have checked and there are none. A gap the reviewer finds and you did not
declare is a more serious finding than the gap itself.>

## Checklist

- [ ] `pnpm check:fast`, `pnpm test` and `pnpm build` pass
- [ ] Documentation is updated
- [ ] No secrets or local files are committed
