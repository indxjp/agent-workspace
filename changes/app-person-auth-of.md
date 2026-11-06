---
changelog: app
section: Added
---

- `personAuthOf(request)` from `@indx-workspace/app/server`: the signed-in person's token in the
  request as the SDK's auth (`access-token` or `user-token`), so a page or route calls Agent
  Workspace as that person, as the portal template's pages do.
- Every server handler reads `AW_WORKSPACE_ID`, the one workspace the deployment serves, and
  `currentPerson` answers no person (`401 unauthenticated`) for a member of any other workspace, so
  the app's tables never hold rows of a tenant it was not installed for.
