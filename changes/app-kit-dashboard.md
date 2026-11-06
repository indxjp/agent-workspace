---
changelog: app
section: Added
---

- `dashboardRoutes()` from `@indx-workspace/app/server`: `GET /api/dashboard`, J5's four lists read
  from Agent Workspace's run list with the signed-in person's own token, so a person never sees a
  run they could not open in the console. `running` is the `queued` and `running` runs,
  `waiting` the `awaiting_approval` runs with the tool each waits on, `failed` the failures created
  in the last 24 hours, and `spendToday` today's cost by currency (from midnight in the route's
  `timeZone`, UTC by default), summed exactly on decimal strings with the runs whose accounting has
  not settled counted as `unsettled`. Each run carries only its id, agent, status, times, error,
  pending call, cost and lead run (`parentRunId`), never its prompt or output. A list that stops at
  a page says so in `truncated`. Each person's answer is kept for 900 ms and the spend walk for
  10 s; a refusal of Agent Workspace's comes back by its code and status. `loadDashboard` is the
  same read without the route.
- `Dashboard({ platformUrl })` from `@indx-workspace/app/react`: the four lists as `<section>`s,
  each with an `h2`, a table and an empty line, every row a link named "Open run <id>" to
  `${platformUrl}/runs?run=<id>`. It polls every second while the page is visible, never two
  requests at once, and pauses while it is hidden. The spend list says that no spend ceiling is
  configured. It speaks `ja` and `en`, and adds no charts dependency. `dashboardClient()` is its way
  to the route.
