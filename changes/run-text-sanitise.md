---
changelog: platform
section: Fixed
---

- A run no longer fails with "The runtime stream ended unexpectedly" when a tool reads a binary
  file (NUL characters) or its output is cut inside an emoji; the unstorable characters become
  U+FFFD. Shell output no longer turns a multi-byte character split across two reads into U+FFFD,
  and an evaluation judge's reason can no longer lose the evaluation the same way (#2283).
