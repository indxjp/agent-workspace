# W1-UI-01 — The shell shows what the session knows, and says "not configured" for what nothing does

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-01 (UI)
Scope: `apps/web/app/(shell)/layout.tsx`, `apps/web/components/shell/{sidebar,topbar,identity}.tsx`

## Context

Three pieces of the shell chrome are filled from a demo constant in `ui/assets/app.js`, labelled
there as "workspace demo context":

```text
WORKSPACE = { name: "Meridian Manufacturing", plan: "Self-hosted · v0.4.2" }
USER      = { name: "Aya Ito", role: "Owner", initials: "AI" }
RUNTIME   = { label: "Docker · Standard Sandbox", warn: false }
```

A PL-0 transcription copies the visible strings exactly. These three are not visible strings; they
are stand-ins for data, and copying them would ship a fictional company, a fictional person and a
claim about an isolation driver into the product.

The runtime one matters most. Spec A.3 requires the top bar of every screen to name the driver in
force, and §14.8 forbids assigning an unverified runtime. Wave 1 registers no runtime with the
control plane at all — `apps/web/server/runs/environment.ts` answers `503` and names the missing
piece until an adapter is installed on purpose.

## Decision

**Identity comes from the session.** The layout calls `getSession()`, which never throws and
returns `null` for an absent or invalid session, so reading it does not gate the page surface —
which matters, because no Wave 1 task owns a sign-in page and gating the shell would redirect an
unauthenticated browser to a route that does not exist
(docs/adr/W1-CP-06-the-gate-covers-api-only.md).

* With a session: the brand line is the workspace slug the session carries, and the foot shows the
  session's email address with its role. The avatar's two letters are derived from the address's
  local part — one letter from each of its first two words, or its first two letters when it has
  one word — which is the mockup's own two-letter shape applied to the only name Wave 1 has.
* Without one: the brand reads `Agent Workspace · Self-hosted`, and the identity chip is **omitted
  entirely** rather than filled with a placeholder person.

**The runtime chip says `Runtime: not configured`, in the warn variant, linking nowhere.** "Not
configured" is the vocabulary `ui/runtimes.html` already uses for a driver with nothing behind it,
so it is transcribed rather than invented. The warn variant makes it read as a gap rather than as
a healthy default, and it links nowhere because the Runtimes screen is not built. This is
ADR-0015 applied to a piece of chrome: the bar cannot answer "which driver is in force", so it
says so, instead of naming a plausible one.

## Alternatives rejected

**Transcribe the demo strings.** Fastest to a matching screenshot, and the screenshot would be the
only place it ever looked right. A green runtime chip reading "Docker · Standard Sandbox" over a
deployment with no runtime is a false statement about isolation, which is the most expensive kind
of dishonesty this product can ship.

**Omit the runtime chip until a runtime exists.** Honest, in that it claims nothing. It also drops
an element A.3 requires on every screen, and it hides the gap instead of showing it — the operator
learns nothing about why runs do not work.

**Use `requireSession()` and redirect.** The correct end state, and it cannot be built yet: there
is nowhere to redirect to, and it would break the two UI tasks stacked above this one.

## Downside, stated honestly

* **The brand shows a slug, not a name.** `workspaces.name` exists in the schema; the session
  carries `ws`, the slug (docs/adr/W1-CP-06-session-carries-the-workspace-slug.md). So a signed-in
  operator sees `meridian`, not `Meridian Manufacturing`. Reading the workspace row needs a query
  this task does not own.
* **The version is dropped.** The mockup's second brand line is `Self-hosted · v0.4.2`; the
  package version on this branch is `0.0.0` and means nothing, so the line reads `Self-hosted`.
* **The identity chip is inert.** In the mockup it has a hover state and a pointer cursor,
  implying a menu. There is no menu, so the hover state is not transcribed — a control that
  highlights and then does nothing is worse than one that does not highlight.
* **The layout became dynamic.** `getSession()` reads cookies, so every route under `(shell)` is
  rendered per request. For a self-hosted control plane behind authentication this is the correct
  default and not a cost worth engineering around, but it is a consequence, not an accident.
* **The counts are gone.** The mockup's sidebar shows `3`, `6`, `4`, `5` beside Projects, Agents,
  Skills and Connectors. Those are demo data over resources Wave 1 cannot count, and they are
  omitted for the same reason as the workspace name. The `.count` styling is not carried either;
  the task that can count adds both.
