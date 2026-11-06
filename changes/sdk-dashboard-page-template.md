---
changelog: sdk
section: Changed
---

- The `page/dashboard` template draws the app kit's `Dashboard` instead of a placeholder grid, and
  writes its route too, `app/api/dashboard/route.ts` (`export const { GET } = dashboardRoutes();`),
  so `aw generate page <name> --kind dashboard` gives a working dashboard.
