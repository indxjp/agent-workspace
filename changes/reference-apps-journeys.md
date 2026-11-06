---
changelog: platform
section: Changed
---

- The reference apps' journeys now sign their browser in through the portal's own `/sign-in` at
  `aw dev`'s development issuer (#1530, on #2075, #2076 and #2077), so a run started or decided in
  the app is the signed-in person's. The wiki offers its `writer` on each page: the page's agent
  panel summarizes a page tree into a new page whose first revision carries the panel's run. The
  CRM's agent panel runs as the person. The service desk's journey fires the SLA sweep's slot past
  a ticket's SLA, approves the closure in `RecipeGraph`, and checks the ticket's history links the
  triage, escalation and closure writes to their runs, and its home Dashboard lists the approval
  waiting as the person. The wiki, CRM and service desk now score every cell.
