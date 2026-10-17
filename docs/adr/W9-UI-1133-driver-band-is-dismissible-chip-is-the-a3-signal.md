# W9-UI-1133 — The driver band is dismissible; the top bar chip is the A.3 signal

Status: proposed — amends W7-UI-04's acceptance line in the development plan
Date: 2026-10-14
Decided by: W9-UI-1133 (implementing agent); awaiting owner acceptance
Scope: `apps/web/components/shell/dismissible-notice.tsx`, `driver-banner.tsx`, `topbar.tsx`,
`workspace-switcher.tsx`; `apps/web/components/models/model-selector.tsx`;
`apps/web/app/(shell)/layout.tsx`; `tests/browser/notices.spec.mjs`

## Context

W7-UI-04 (the development plan) shipped "the persistent driver banner required by A.3" with
the acceptance line "the banner is present on every screen when the driver is `local`". Spec A.3
(`docs/spec.md`) asks less: every screen must **show which driver is in force**. On shell screens
the top bar's runtime chip (`components/shell/topbar.tsx`) already does that, amber for `local` and
for an unconfigured driver, so the full-width amber band under it repeats the chip on every screen
with no way to close it. Issue #1133 reports it as noise and asks for an × that stays closed.

## Decision

1. **The runtime chip is the non-dismissible A.3 signal on shell screens.** It stays on every shell
   screen, amber for `local`, and for `local` its hover title names the reason ("No tenant
   isolation: commands run as the host user").
2. **The driver band is dismissible per browser.** The × stores a version (`driver=local`,
   `driver=not configured`) under `aw.notice.dismissed.driver` in `localStorage`; the band comes
   back when the driver changes. It renders visible on the server and first client render and hides
   in an effect, so a reload may flash it — erring toward showing the warning.
3. **A configured driver other than `local` gets no band.** "Configured for this deployment" added
   nothing the chip does not say.
4. **Public pages (`/signin`, `/p/**`) keep the band**, dismissible the same way, because they have
   no top bar chip: the screen names the driver until this browser's user closes it.
5. The setup wizard's own `DriverBanner` (the runtime it detected or the user chose) is unchanged.
6. The same component makes the archived-workspace band and the model-unavailable notice
   dismissible, versioned by `archivedAt` and by the unavailable connections respectively.

A server-side preference, or a cookie that would let the server skip the band, is not adopted: the
dismissal is a per-browser display preference, and a cookie would touch every layout's request
handling to avoid a flash the issue accepts.

## Consequences

- A developer can hide the `local` isolation warning band. The amber chip still names `local` on
  every shell screen; a public page shows no driver once its band is dismissed in that browser.
- Clearing site data restores every notice. Leftover `aw.notice.dismissed.*` keys are harmless.
- `tests/screen-driver-banner.test.ts` still holds: every screen mounts `<DeploymentDriverBanner`
  or the wizard's `<DriverBanner`; what it renders now depends on the driver and the dismissal.
