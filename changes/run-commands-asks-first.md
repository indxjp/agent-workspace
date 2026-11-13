---
changelog: platform
section: Changed
---

- With **Run commands** on, a shell command that changes something now pauses the run and asks:
  the chat shows Approve and Reject, and Approve runs that one command. Before, the command was
  refused with nobody asked and the run still ended Completed (#2091). A read-only command, and a
  command the stored policy already allows, still runs without asking. The agent form says so.
