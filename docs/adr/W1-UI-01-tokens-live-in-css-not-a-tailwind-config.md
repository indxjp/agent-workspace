# W1-UI-01 — The design tokens live in `globals.css`, and there is no `tailwind.config.ts`

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-01 (UI)
Scope: `apps/web/app/globals.css`; binding on every later UI task that spends a design token

## Context

The task card says the tokens are "ported verbatim from `ui/assets/app.css` to Tailwind theme
variables", and this task's declared ownership names `apps/web/tailwind.config.ts`. That name
describes Tailwind 3. `apps/web/package.json` on this branch depends on `tailwindcss@4.3.3` with
`@tailwindcss/postcss`, and Tailwind 4 has no `tailwind.config.ts` unless a file asks for one with
`@config` — the theme is declared in CSS, in an `@theme` block.

Two things about the mockup's tokens decide the rest. They swap under a `prefers-color-scheme`
media query and under nothing else — there is no theme switch in any of the twenty-five screens.
And three of their names (`--radius-sm`, `--shadow`, `--shadow-lg`) are also names in Tailwind's
own default theme.

## Decision

**No `tailwind.config.ts` is created.** The tokens are declared in `apps/web/app/globals.css` in
two blocks — a `:root` block and a `@media (prefers-color-scheme: dark)` block — copied from
`ui/assets/app.css` with the names, values and order unchanged, and are exposed to Tailwind
through `@theme inline`.

`inline` is the load-bearing word. A plain `@theme` copies the *value* into Tailwind's variable at
build time, which would freeze the light palette into `--color-bg` and leave `bg-bg` unchanged
when the system switches to dark. `@theme inline { --color-bg: var(--bg) }` compiles `bg-bg` to
`background-color: var(--bg)`, so one declaration serves both themes and the media query does the
work.

**Radius and shadow are deliberately not mapped into `@theme`.** `--radius-sm: var(--radius-sm)`
is a self-reference, and so is the shadow pair. Components spend those tokens directly, as
`rounded-(--radius-sm)` and `shadow-(--shadow)`, which reads the same variable the mockup reads.
`--sidebar-w` belongs to no Tailwind namespace and is spent the same way.

**The three colliding names shadow Tailwind's defaults, on purpose.** `@import 'tailwindcss'`
emits its defaults into `:root` above the token block, so the token block wins the cascade and
`rounded-sm`, `shadow` and `shadow-lg` take the design system's values inside this application.
The design system is the source of truth for this product's surfaces; the collision is written
into the file's own comment so it is discovered by reading rather than by wondering why a shadow
looks unfamiliar.

## Alternatives rejected

**Create `tailwind.config.ts` and point at it with `@config`.** It is supported, and it is the
shape the task card's ownership line implies. It buys nothing here — the same values, in a second
file, in a format Tailwind 4 reads through a compatibility path — and it costs a file that every
later UI task has to remember exists. §40 and §39 both point the other way.

**Duplicate the palette: light values in `@theme`, dark values in a `@variant dark` block.** This
is the shape Tailwind's own documentation shows for a class-based dark mode. It writes every
colour twice, and the two copies drift; and it models a theme *switch*, which this product does
not have.

**Port the whole of `ui/assets/app.css`, all 570 lines, and use its class names.** Pixel-identical
by construction, and the fastest route to a matching screenshot. Rejected: it is not a Tailwind
theme, the mockup's component classes are not a component library, and the next UI task would
inherit a second styling system to keep in sync with the first. The tokens are the shared part;
the components are transcribed per screen.

## Downside, stated honestly

The bytes of the token block are not identical to `ui/assets/app.css`. Prettier reformats this
file — quote style, spacing inside `rgba()`, `.05` written as `0.05`, long font stacks wrapped —
so a `diff` of the two files is not the check. The check is a comparison that normalises
formatting and nothing else, and this task ran it: 47 tokens across both themes, 0 mismatches. It
is a script in the acceptance rather than a gate in CI, which means nothing stops a later edit
from drifting a value; making it a gate needs a file this task does not own, and is the honest
gap.

A second, smaller one: Tailwind's build minifies colours in the emitted stylesheet, so
`rgba(24,23,20,.05)` is served as `#1817140d`. Two alpha channels round in the eighth bit —
`.05` → 0.0510, `.55` → 0.5490 — because eight-bit hex cannot hold either exactly. The rendered
`box-shadow` on the active navigation item was measured in Chrome against the mockup's and reads
`rgba(24, 23, 20, 0.05)` on both.
