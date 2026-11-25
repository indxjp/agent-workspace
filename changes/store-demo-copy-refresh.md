---
changelog: platform
section: Fixed
---

- Refilling the Agent Store's verification workspace (`PUT /api/demo/verification/{workspaceId}`) now brings every
  copy to its current template: an agent's instructions, permissions and assignments, a skill's files and a stand-in's
  tools and records are updated in place, and the sample files are reset to the template's (#2407). Before, a refill
  kept every agent, skill and stand-in an earlier fill had made, so the real-model verification ran against the
  copies of the first fill. A refill also clears the approved writes the verification stand-ins kept, so each
  real-model run starts from the seeded records. A visitor's demo keeps its approved writes across a refresh, including
  one after a deploy that changes the stand-in's code, while the stand-in still records that write.
- Two demo entries that name the same connector now each get their own stand-in in one workspace (the second is named
  `<connector>-<entry>`), with their own tools and records. Before, the second entry ran on the first one's stand-in.
