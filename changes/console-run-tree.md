---
changelog: platform
section: Added
---

- The console's run detail shows the run tree of an agent team run (ADR-0104, #1517): a Team card
  lists each child run as a collapsible row with its status, cost and a link to it, the tree cost
  sits beside the run's own cost, and a child run links back to its lead run. In the run view, an
  `agent__<member>` activity row shows the member name and links to the child run it started. The
  new strings are in English and Japanese.
