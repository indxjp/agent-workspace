---
changelog: app
section: Added
---

- `ResourceFormLoader` (#1531): a resource's edit page by record id. It loads the record through
  the resource's client, then draws `ResourceForm` on it, as `ResourceDetailLoader` does for the
  detail.
- Every part speaks the language of the `AppTheme` around it when it is given no `locale` of its
  own (#1531), so a portal names its language once, in `app/theme.ts`. A part's own `locale` still
  wins, and a part outside any `AppTheme` stays `en`. `AppTheme` is now a client component.
