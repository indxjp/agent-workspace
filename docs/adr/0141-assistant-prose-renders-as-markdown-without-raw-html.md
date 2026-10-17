# ADR-0141 — Assistant prose renders as Markdown, through react-markdown, without raw HTML

Status: accepted
Date: 2026-10-14
Decided by: issue #1131 (amends W1-UI-03); accepted by the owner when #1134 merged
Scope: `packages/react/package.json`, `packages/react/src/assistant-prose.tsx`, `packages/react/src/surface-chat.tsx`, `packages/react/src/styles.css`, `packages/react/src/index.ts`, `apps/web/components/run/run-view.tsx`, `pnpm-lock.yaml`

## Context

[W1-UI-03](W1-UI-03-agent-prose-is-not-markdown.md) made a message body paragraphs of typed inline
runs and rendered every string as a React text node. It rejected a Markdown renderer "under §40 for
this wave" and named it "the right answer eventually", deserving "its own task and its own threat
model". Issue #1131 is that task.

The gap W1-UI-03 declared is now the commonest complaint about the chat. Models answer in Markdown
by default, so almost every reply shows `## headings`, `**bold**` and code fences as source. Every
chat has the gap: the surface chat (`<Chat>`, used by the public page, the try page and the widget,
which is an iframe of the public page) and `RunView` (the home chat and the run page).

§40 asks whether the job fits in about 50 lines of clear TypeScript. It does not. W1-UI-03 already
rejected a hand-written subset parser because whoever writes it invents the subset's edges, and
every missing construct shows up as literal asterisks. Turning untrusted Markdown into DOM safely
is also security work: the widget runs on third-party sites, so an XSS in this path reaches them.
§40 sends that kind of problem to a mature library.

## Decision

- **Assistant text is rendered as Markdown; user text is not.** User messages and activity fact
  notes keep W1-UI-03's literal rendering (`<p className="aw-paragraph">` / `Runs`).
- **The renderer is `react-markdown` with `remark-gfm`, pinned exactly** (`react-markdown` 10.1.0,
  `remark-gfm` 4.0.1, the version already in the lockfile through `chat`). They are dependencies of
  the published `@indx-workspace/react`, under a §40 exception for untrusted-content parsing. Both
  are MIT and pass `scripts/check-licenses.mjs`.
- **One component renders it**: `AssistantProse` in `packages/react/src/assistant-prose.tsx`,
  exported from the package. Both chats call it once per model text block, so an unclosed fence in a
  streaming block cannot swallow the next block.
- **The threat model.** Agent output is untrusted, and the surface chat runs inside customers'
  pages. The component holds these properties, and tests in both chats check them:
  1. **No HTML string.** react-markdown builds React elements from the syntax tree. Nothing passes a
     string to `dangerouslySetInnerHTML`, and no `rehype-raw` (or any other plugin that parses raw
     HTML) is added.
  2. **Raw HTML is dropped** (`skipHtml`). `<script>` and `<img onerror>` in agent text produce no
     element and no attribute.
  3. **Elements are allow-listed**: `p`, `h1`–`h6`, `strong`, `em`, `del`, `code`, `pre`, `ul`,
     `ol`, `li`, `a`, `blockquote`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `hr`, `br`. `img` is
     left out on purpose: an image makes the reader's browser fetch a URL the model chose, which
     leaks the visit and can carry data out in the URL. `unwrapDisallowed` is set, so any other
     element keeps its text and loses only its markup.
  4. **URLs are filtered** by react-markdown's `defaultUrlTransform`, which keeps only `http`,
     `https`, `mailto`, `irc`, `ircs`, `xmpp` and relative URLs. `javascript:`, `vbscript:` and
     `data:` links render with an empty `href`.
  5. **Links open outside the chat** with `target="_blank"` and
     `rel="noopener noreferrer nofollow"`. The opened page gets no `window.opener` and no referrer,
     and search engines get no endorsement of a model-chosen URL.
  6. **Partial input renders.** A streamed block may stop inside a fence, a list or a table. That
     is valid Markdown and renders without throwing.
- **Styling** stays in each chat's own world. The surface chat uses `.aw-prose` rules in
  `styles.css` built from the existing design tokens. `RunView` uses Tailwind classes at the call
  site, because `styles.css` is not loaded there. `.aw-prose` does not use `white-space: pre-wrap`.
- **Out of scope**: syntax highlighting, math, Mermaid, and Markdown in user messages. Each of
  these would be a new decision.

## Alternatives considered

- **A hand-written subset parser.** Rejected again, for W1-UI-03's reasons. If this ADR is not
  accepted, the chat keeps rendering literal text. A subset parser is not the fallback.
- **`marked` (or `markdown-it`) plus DOMPurify.** Rejected. It is two libraries, it builds an HTML
  string, and it needs `dangerouslySetInnerHTML`. Its safety depends on a sanitiser configuration
  that someone can loosen later. react-markdown never produces markup from a string, so there is no
  sanitiser to get wrong.
- **Load `styles.css` on the RunView screens.** Rejected. Its global `.aw-*` and `body` rules would
  leak into the Tailwind app.
- **Turn the `Inline` model into a Markdown AST.** Not needed. As W1-UI-03 predicted, the change
  touches the paragraph renderer only. `Inline` stays for user text and fact notes.
- **Add `remark-breaks` to keep single newlines.** Deferred. Standard Markdown joins a single
  newline inside a paragraph, and a third dependency needs its own reason.

## Consequences

- Headings, emphasis, lists, code blocks, links and GFM tables render in every chat.
- `@indx-workspace/react` gains a runtime dependency tree of about 40 small unified/micromark
  packages. Most are already in the lockfile through `chat`. Consumers install them transitively.
- Assistant paragraphs lose `pre-wrap`, so single newlines join, as Markdown specifies.
- Adding `rehype-raw`, `img`, a custom `urlTransform` or `dangerouslySetInnerHTML` to this path
  reverses this ADR's threat model and needs a new ADR.
- W1-UI-03's "no code path on this screen turns a string into markup" now has one exception. The
  path is a parser that builds a tree with an element allow-list, not an HTML sink.
