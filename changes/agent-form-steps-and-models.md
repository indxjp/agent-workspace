---
changelog: platform
section: Fixed
---

- The New Agent form numbers its steps 1 to 5 in the order they appear; it showed Step 5, 3, 4.
  Every model picker lists each model once, even when two model connections offer it, and asks
  which connection to use only when more than one offers the chosen model (UX-22 in #2086).
