---
changelog: app
section: Added
---

- `@indx-workspace/app/react`: `ResourceDetailLoader`, the detail page of a record by its id. It
  loads the record through the resource's client and draws `ResourceDetail`; until then it
  announces the loading record, and when the record cannot be had it says why in `ja` or `en` with
  a button to try again.
