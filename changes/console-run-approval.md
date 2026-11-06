---
changelog: platform
section: Added
---

- The console chat shows Approve and Reject when an agent pauses before a tool call that needs
  approval, and follows the run the decision continues in the same conversation. Before, the
  chat showed only an "Awaiting approval" badge and the decision could be sent through the API
  only.
  While the card asks, and while the continued run is queued or running, the follow-up box waits,
  so a new message can neither hide the request nor cut off the approved call.
