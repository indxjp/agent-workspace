/**
 * This task's acceptance criterion, asserted: **one run component; the home route renders it after
 * the first message; Show technical details is collapsed by default.**
 *
 * Three of the four assertions below render real React. The fourth is derived from the source tree,
 * because "there is no second chat implementation" (§19.5.1 rule 5) is a property of the repository
 * and not of any one module — nothing you can render tells you whether somebody added a second one
 * next door.
 *
 * ## Why this file renders to a string rather than driving a DOM
 *
 * There is no jsdom and no React testing library in this repository, and §40 makes adding one the
 * last resort. `react-dom/server` is already a dependency of `apps/web` and renders the real
 * component tree — which is enough for every assertion here, because all three rendered claims are
 * about *markup*: which screen was produced, and whether a `<details>` carries `open`.
 *
 * The one thing it cannot do is press a button, so the transition is asserted in two halves that
 * meet in the middle: `beginRun` is the only constructor of a `Run` and the test drives it with a
 * first message; `HomeChat` is then rendered with exactly that value and must produce the run view.
 * The half a string render cannot cover — that **Send** calls `beginRun` — is covered by the
 * source-derived test at the bottom, which fails if `home-chat.tsx` stops importing it. This is
 * stated plainly in the pull request's Declared gaps rather than glossed as a full interaction test.
 *
 * The `apps/web` Vitest project needs `oxc.jsx.runtime: 'automatic'` for any of this to load, since
 * `apps/web/tsconfig.json` sets `jsx: "preserve"` for Next.js and Vite refuses to transform a file
 * it is told to preserve. That is `apps/web/vitest.config.mts`; see
 * `docs/adr/W1-UI-03-the-web-project-can-load-its-own-components-in-a-test.md`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HomeChat, type ComposerAgents } from '../composer/home-chat';
import { MOCKUP_AGENTS } from '../composer/mockup-fixture';
import { sharePublishPayload } from '../shares/share-dialog';
import { MOCKUP_RUN, MOCKUP_RUN_COMPLETED } from './mockup-fixture';
import { RunView, shareableTranscript, shareSubjectForSession } from './run-view';
import {
  NotARunError,
  beginRun,
  plain,
  screenFor,
  userMessage,
  withMessage,
  type Run,
  type RunOpening,
  type Speaker,
  withAssistantResponse,
} from '@indx-workspace/react/run-model';

const AGENTS: ComposerAgents = { kind: 'agents', agents: MOCKUP_AGENTS };
const USER: Speaker = { initials: 'AI', name: 'Aya Ito' };

const OPENING: RunOpening = {
  heading: { title: 'General', subtitle: '', status: null, actions: [] },
  followUp: {
    placeholder:
      'Ask a follow-up. The session is resumed, so the agent still has the context above.',
    actions: [],
    status: 'Standard Sandbox · read-only',
  },
};

/** The run the home chat holds immediately after **Send** is pressed the first time. */
function afterTheFirstMessage(text: string): Run {
  return beginRun(OPENING, userMessage('m0-1', USER, text));
}

function home(props: { readonly run?: Run | null } = {}): string {
  return renderToStaticMarkup(
    createElement(HomeChat, { agents: AGENTS, recent: [], user: USER, ...props }),
  );
}

describe('session sharing', () => {
  it('uses only the durable session id and never falls back to display text', () => {
    expect(shareSubjectForSession(null, 'General')).toBeNull();
    expect(shareSubjectForSession('', 'General')).toBeNull();
    expect(shareSubjectForSession('  d1111111-1111-4111-8111-111111111111  ', 'General')).toEqual({
      type: 'session',
      id: 'd1111111-1111-4111-8111-111111111111',
      label: 'General',
    });
  });

  it('publishes the visible conversation as the immutable session snapshot', () => {
    const transcript = [
      { kind: 'user', text: 'Can you hear me?' },
      { kind: 'agent', text: 'Yes.' },
    ];

    expect(
      sharePublishPayload(
        {
          type: 'session',
          id: 'd1111111-1111-4111-8111-111111111111',
          label: 'General',
        },
        'public',
        '24 h',
        '',
        transcript,
      ),
    ).toEqual({
      subjectType: 'session',
      subjectId: 'd1111111-1111-4111-8111-111111111111',
      subjectLabel: 'General',
      visibility: 'public',
      expiry: '24 h',
      transcript,
    });
  });

  it('removes user identity from the transcript before it reaches the sharing boundary', () => {
    const transcript = shareableTranscript([
      userMessage('user-1', { initials: 'A', name: 'alex@example.com' }, 'Keep this private.'),
      MOCKUP_RUN_COMPLETED.messages.find((message) => message.kind === 'agent') ??
        (() => {
          throw new Error('the completed fixture has no agent message');
        })(),
    ]);

    expect(JSON.stringify(transcript)).not.toContain('alex@example.com');
    expect(JSON.stringify(transcript)).not.toContain('"speaker"');
    expect(transcript[0]).toEqual({
      kind: 'user',
      id: 'user-1',
      paragraphs: [[{ text: 'Keep this private.', strong: false, mono: false }]],
    });
  });
});

// ── The acceptance criterion ────────────────────────────────────────────────────────────────────

describe('§19.5.1 rule 5 — the home chat becomes the run view', () => {
  it('is the composer before the first message', () => {
    const html = home();

    // The hero §45 prints, and nothing from the run view.
    expect(html).toContain('What can I help with?');
    expect(html).not.toContain('Show technical details');
  });

  it('is the run view after the first message, and the same component', () => {
    const first = 'Prepare a summary of these contracts.';
    const html = home({ run: afterTheFirstMessage(first) });

    // The run view, produced by the home route's own component…
    expect(html).toContain('Show technical details');
    expect(html).toContain(first);
    expect(html).toContain('Aya Ito');
    // …and the composer screen it replaced is gone. Both halves matter: a screen that showed the
    // hero *and* the transcript would pass a "contains" assertion while being two screens.
    expect(html).not.toContain('What can I help with?');
  });

  it('renders the very same markup the run component renders on its own', () => {
    // "One run component" as an equality rather than a resemblance. If the home chat ever grew its
    // own transcript, these two strings would drift on the first divergent line.
    const run = afterTheFirstMessage('Prepare a summary of these contracts.');
    expect(home({ run })).toBe(
      renderToStaticMarkup(createElement(RunView, { run, sessionId: null })),
    );
  });

  it('reaches the run view only through screenFor, which refuses anything that is not a run', () => {
    expect(screenFor(null)).toEqual({ kind: 'composer' });

    const run = afterTheFirstMessage('hello');
    expect(screenFor(run)).toEqual({ kind: 'run', run });

    // A check that cannot run FAILS (ADR-0015). None of these may fall through to the composer,
    // which would silently discard a conversation in flight.
    for (const bad of [undefined, 0, '', 'run', false, NaN, [], {}, { messages: [] }]) {
      expect(() => screenFor(bad)).toThrow(NotARunError);
    }
  });

  it('cannot represent a run that has not had its first message', () => {
    // The transition is a property of the type, not of a length check somebody can forget.
    expect(() => beginRun(OPENING, { kind: 'agent', id: 'a', speaker: USER, blocks: [] })).toThrow(
      NotARunError,
    );
    for (const empty of ['', '   ', '\n\t']) {
      expect(() => userMessage('m', USER, empty)).toThrow(NotARunError);
    }
  });
});

// ── §19 — the disclosure ────────────────────────────────────────────────────────────────────────

describe('§19 — Show technical details is collapsed by default', () => {
  const OPEN_DETAILS = /<details\b[^>]*\bopen\b/u;

  it('renders a <details> that carries no open attribute, on either screen', () => {
    for (const markup of [
      renderToStaticMarkup(createElement(RunView, { run: MOCKUP_RUN, sessionId: null })),
      renderToStaticMarkup(createElement(RunView, { run: MOCKUP_RUN_COMPLETED, sessionId: null })),
      home({ run: afterTheFirstMessage('hello') }),
    ]) {
      expect(markup).toContain('<details');
      expect(markup).toContain('Show technical details');
      expect(markup).not.toMatch(OPEN_DETAILS);
    }
  });

  it('keeps the SDK event stream out of the transcript', () => {
    // §19's whole shape: plain language above, the raw stream behind the disclosure. The activity
    // list says "Read"; the event log says "tool_use.Read". Both are present, and the first line of
    // the transcript is the plain one.
    const html = renderToStaticMarkup(createElement(RunView, { run: MOCKUP_RUN, sessionId: null }));
    expect(html.indexOf('Reviewing the uploaded files')).toBeLessThan(
      html.indexOf('Show technical details'),
    );
    expect(html.indexOf('Show technical details')).toBeLessThan(html.indexOf('system.init'));
  });

  it('shows a running step with a spinner and a finished one with a tick', () => {
    const running = renderToStaticMarkup(
      createElement(RunView, { run: MOCKUP_RUN, sessionId: null }),
    );
    expect(running).toContain('Preparing summary…');
    expect(running).toContain('animate-spin');

    const finished = renderToStaticMarkup(
      createElement(RunView, { run: MOCKUP_RUN_COMPLETED, sessionId: null }),
    );
    expect(finished).toContain('✓');
    expect(finished).not.toContain('animate-spin');
  });
});

// ── One run component, one chat implementation ──────────────────────────────────────────────────

describe('there is no second chat implementation', () => {
  const WEB = join(import.meta.dirname, '..', '..');
  /** The hosted surface chat, published as `@indx-workspace/react` (issue #623). */
  const REACT = join(WEB, '..', '..', 'packages', 'react', 'src');

  function filesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) found.push(...filesUnder(full));
      else if (/\.tsx?$/u.test(entry)) found.push(full);
    }
    return found;
  }

  /**
   * Every component under `apps/web` and `packages/react` — the `.tsx` files that are not tests.
   *
   * `.ts` is excluded because a module that renders nothing cannot be a second chat, and including
   * it would make the two scans below fire on the words in a doc comment. The scans are for markup
   * a component emits, so components are what they read.
   */
  function components(): { readonly path: string; readonly source: string }[] {
    const files = [...filesUnder(WEB), ...filesUnder(REACT)]
      .filter((file) => /\.tsx$/u.test(file) && !/\.test\.tsx$/u.test(file))
      .map((path) => ({ path: path.replaceAll('\\', '/'), source: readFileSync(path, 'utf8') }));

    // The scan is derived from the tree, so it must fail when the tree is not what it thinks.
    // A check that found no files to read has not passed (ADR-0015).
    expect(files.length).toBeGreaterThan(4);
    return files;
  }

  function paths(files: { readonly path: string }[]): string[] {
    return files
      .map((file) => /(?:apps\/web|packages\/react)\/.*$/u.exec(file.path)?.[0] ?? file.path)
      .sort();
  }

  /** Whether a component's source renders a `<textarea>`, as JSX or through `createElement`. */
  function rendersTextarea(source: string): boolean {
    return source.includes('<textarea') || /createElement\(\s*['"]textarea['"]/u.test(source);
  }

  /** The module specifiers a source imports from, static or re-exported. */
  function importsOf(source: string): string[] {
    return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)].map((match) => match[1] ?? '');
  }

  /**
   * Whether a component imports the chat machinery: anything under `components/run` (the run
   * view, the live transport), the run model (`@indx-workspace/react/run-model`), or the published
   * SDK that starts and follows runs.
   */
  function importsChatMachinery(file: { readonly path: string; readonly source: string }): boolean {
    const directory = file.path.slice(0, file.path.lastIndexOf('/'));
    return importsOf(file.source).some((specifier) => {
      if (specifier.startsWith('@indx-workspace/sdk')) return true;
      if (specifier === '@indx-workspace/react/run-model') return true;
      if (!specifier.startsWith('.')) return false;
      const resolved = join(directory, specifier).replaceAll('\\', '/');
      return (
        resolved.includes('/apps/web/components/run/') ||
        resolved.endsWith('/packages/react/src/run-model.js')
      );
    });
  }

  /**
   * Message boxes that are not chats: forms whose `<textarea>` edits a field. Exact, so a new
   * textarea anywhere in `apps/web` must be classified here or as a composer below.
   */
  const NON_CHAT_TEXTAREAS = [
    'apps/web/components/agents/agent-detail.tsx',
    'apps/web/components/agents/agent-form.tsx',
    'apps/web/components/projects/project-form.tsx',
    'apps/web/components/resources/resource-screens.tsx',
  ];

  it('has exactly one composer per chat — the workspace chat and the hosted surface chat', () => {
    // Every `<textarea>` in a component, whatever its label, is found. `run-view.tsx` is the same
    // chat after the first message, which is what rule 5 asks for; `packages/react`'s
    // `surface-chat.tsx` is the visitor's chat of a hosted surface (ADR-0105, S1-17; issue #623),
    // which shares the run model rather than forking it. A fourth chat composer here is the fork this test exists to catch.
    const textareas = components().filter((file) => rendersTextarea(file.source));
    const composers = textareas.filter(importsChatMachinery);

    expect(paths(composers)).toEqual([
      'apps/web/components/composer/home-chat.tsx',
      'apps/web/components/run/run-view.tsx',
      'packages/react/src/surface-chat.tsx',
    ]);
    expect(paths(textareas.filter((file) => !importsChatMachinery(file)))).toEqual(
      NON_CHAT_TEXTAREAS,
    );
  });

  it('builds the surface chat on the run model and the published SDK, not a second transport', () => {
    // The component draws the transcript; its send path (bootstrap, start, follow) is its own file.
    const surface = ['surface-chat.tsx', 'surface-chat-send.ts']
      .map((file) => readFileSync(join(REACT, file), 'utf8'))
      .join('\n');
    expect(surface).toContain("from './run-model.js'");
    expect(surface).toContain("from '@indx-workspace/sdk'");
    expect(surface).not.toContain('../run/live');
    expect(surface).not.toContain('../run/run-view');
  });

  it('has exactly one run component — one place that draws the §19 disclosure', () => {
    expect(
      paths(components().filter((file) => file.source.includes('Show technical details'))),
    ).toEqual(['apps/web/components/run/run-view.tsx']);
  });

  it('routes the home page through that one chat, which imports that one run view', () => {
    const page = readFileSync(join(WEB, 'app', '(shell)', 'page.tsx'), 'utf8');
    expect(page).toContain('HomeChat');
    expect(page).toContain("from '../../components/composer/home-chat'");

    // The half a string render cannot press: Send calls beginRun, and the screen decision is
    // screenFor. If either import disappears, rule 5 has been broken somewhere this file cannot
    // see, and this assertion is what says so.
    const chat = readFileSync(join(WEB, 'components', 'composer', 'home-chat.tsx'), 'utf8');
    expect(chat).toContain("from '../run/run-view'");
    expect(chat).toContain('beginRun(');
    expect(chat).toContain('screenFor(');
    expect(chat).toContain('sessionId={activeSessionId}');
  });

  it('keeps the mockup fixture out of every route', () => {
    // The mockup's session belongs to a fictional workspace. A route that imported it would show a
    // run nobody started — a capability asserted because nothing contradicted it.
    const routes = filesUnder(join(WEB, 'app'));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((file) => readFileSync(file, 'utf8').includes('mockup-fixture'))).toEqual(
      [],
    );
  });
});

// ── The transcript grows without losing its first message ───────────────────────────────────────

describe('the transcript', () => {
  it('keeps the first message when the agent answers', () => {
    const run = afterTheFirstMessage('Prepare a summary of these contracts.');
    const answered = withMessage(run, {
      kind: 'agent',
      id: 'm0-2',
      speaker: { initials: 'GE', name: 'General' },
      blocks: [{ kind: 'prose', paragraphs: [plain('Reviewing the uploaded files…')] }],
    });

    expect(answered.messages).toHaveLength(2);
    expect(answered.messages[0]).toBe(run.messages[0]);
    expect(screenFor(answered).kind).toBe('run');
  });
});

// ── Assistant prose is Markdown; user text is literal (ADR-0141, #1131) ──────────────────────────

describe('assistant Markdown', () => {
  function answered(question: string, answer: string): string {
    const run = withAssistantResponse(
      afterTheFirstMessage(question),
      { initials: 'GE', name: 'General' },
      { id: 'msg_1', text: [answer] },
    );
    return renderToStaticMarkup(createElement(RunView, { run, sessionId: null }));
  }

  it('renders headings, bold and code blocks instead of their source', () => {
    const html = answered(
      'How do I get started?',
      '## Quick Start Guide\n\n**1. Install dependencies:**\n\n```bash\nnpm install\n```',
    );
    expect(html).toContain('>Quick Start Guide</h2>');
    expect(html).toContain('<strong>1. Install dependencies:</strong>');
    expect(html).toMatch(/<pre><code[^>]*>npm install\n<\/code><\/pre>/u);
    expect(html).not.toContain('**');
    expect(html).not.toContain('```');
  });

  it('drops raw HTML, images and unsafe link schemes', () => {
    const html = answered(
      'Hi',
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [y](data:text/html,<b>x</b>) ![i](https://e.x/a.png)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('href="data:');
  });

  it('keeps a user message literal', () => {
    expect(answered('**x**', 'Sure.')).toContain('<span>**x**</span>');
  });
});
