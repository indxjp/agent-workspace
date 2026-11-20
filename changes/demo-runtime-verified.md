---
changelog: platform
section: Fixed
---

- A visitor's demo workspace, and the verification workspace `PUT /api/demo/verification/{id}` fills, now
  get a current Test Runtime pass of the deployment's runtime driver when the copy is made: the
  instance's own current pass, carried with its own expiry, or a Test Runtime run for the workspace
  when the instance holds none. Before, a run there on any instance but one that had passed Test
  Runtime itself was refused with `runtime_not_verified`, and the guest cannot run Test Runtime.
