# W1-UI-02 — The composer's three in-panel links point nowhere in this wave, so they are not links

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-02 (UI)
Scope: `apps/web/components/composer/home-chat.tsx`

## Context

`ui/home.html` puts three links on this screen outside the composer's own controls:

```text
Manage agents   in the agent picker's footer   → agents.html
Upload          in the Files picker's footer   → files.html
See all         beside the Recent heading      → runs.html
```

None of the three destinations exists on this branch. `components/shell/navigation.ts` carries
`href: null` for Agents, Files and Runs, and the sidebar already renders those entries as disabled
rather than as links that answer a click with a 404
([W1-UI-01](W1-UI-01-a-navigation-entry-with-no-destination-is-disabled.md)).

## Decision

The same answer, in the same idiom. Each of the three renders its label — copied from the mockup,
unchanged — inside a `<span aria-disabled="true">` carrying the design system's disabled treatment,
`opacity: .62` and `cursor: not-allowed`, the values `.choice.disabled` uses in `ui/assets/app.css`.
The sentence around the label is unchanged, so the footers still read exactly as the mockup prints
them.

## Alternatives considered

- **Link them anyway.** Rejected: three 404s, and the quiet dishonesty §43 is written against.
- **Delete the labels.** Rejected: they are part of the transcribed copy, and "Only files this agent
  is permitted to read are listed." reads as truncated without the affordance after it.
- **Invent a "coming soon" treatment.** Rejected: §43's calm, sparse property is lost one convenience
  at a time, and the shell already answers this question one way.

## Consequences

- Three labels on this screen are inert. When Wave 2 builds Agents, Files and Runs, each becomes a
  `Link` by deleting one wrapper — the labels and the surrounding sentences do not change.
- The shell and the composer now share one visual vocabulary for "the destination is absent", which
  is the property that makes it readable rather than looking like three separate bugs.
