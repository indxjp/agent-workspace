import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { withAssistantResponse } from './run-model.js';
import { surfaceStrings } from './locale.js';
import type { ToolResultProps } from './parts.js';
import {
  Chat,
  type ComposerProps,
  type MessageListProps,
  type MessageProps,
  sendsOnEnter,
} from './surface-chat.js';
import {
  surfaceAgentSpeaker,
  withSurfaceFailure,
  withVisitorMessage,
  type SurfaceTurn,
} from './surface-chat-model.js';

const PLAIN: SurfaceDefinition = { name: 'main', agent: 'Support triage' };

const DRESSED: SurfaceDefinition = {
  name: 'main',
  agent: 'Support triage',
  title: 'Help centre',
  theme: { colour: '#0a7f5a', locale: 'ja', logo: { text: 'ACME' } },
  layout: 'side',
  parts: {
    greeting: 'Ask me about your order.',
    suggestedPrompts: ['Where is my order?', 'Talk to a person'],
    disclaimer: 'Answers may be wrong.',
  },
};

describe('Chat (S1-17, #455)', () => {
  it('renders an empty conversation with its own labelled message box', () => {
    const html = renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: PLAIN,
      }),
    );
    expect(html).toContain('<textarea');
    expect(html).toContain('aria-label="Message Support triage"');
    expect(html).toContain('data-surface="main"');
    expect(html).not.toContain('Show technical details');
  });

  it('renders the transcript and a refusal with its code', () => {
    const run = withSurfaceFailure(
      withVisitorMessage(null, 'Support triage', 'visitor-1', 'Where is my order?'),
      'agent "Support triage" has no runtime profile.',
      'agent_runtime_profile_missing',
    );
    const html = renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: PLAIN,
        initialRun: run,
      }),
    );
    expect(html).toContain('Where is my order?');
    expect(html).toContain('agent_runtime_profile_missing');
    expect(html).toContain('has no runtime profile.');
    expect(html).toContain('role="alert"');
  });

  it('shows the limits in the surface language, and closes the composer at the turn limit (#622)', () => {
    const limited = (code: string, message: string): string =>
      renderToStaticMarkup(
        createElement(Chat, {
          surface: 'main',
          agentName: 'Support triage',
          definition: DRESSED,
          initialRun: withSurfaceFailure(
            withVisitorMessage(null, 'Support triage', 'visitor-1', 'こんにちは'),
            message,
            code,
          ),
        }),
      );
    const rate = limited('surface_rate_limited', surfaceStrings('ja').rateLimited(12));
    expect(rate).toContain('12 秒後にもう一度お試しください。');
    expect(rate).not.toMatch(/<textarea[^>]*disabled=""/u);
    const ended = limited('surface_turn_limit_reached', surfaceStrings('ja').turnLimitReached);
    expect(ended).toContain('この会話はメッセージの上限に達しました。');
    expect(ended).toMatch(/<textarea[^>]*disabled=""/u);
  });
});

describe('Chat look, layout and parts (S1-18, #456)', () => {
  it('renders the default look: the agent name, English, the dock layout and no parts', () => {
    const html = renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: PLAIN,
      }),
    );
    expect(html).toContain('>Support triage</h1>');
    expect(html).toContain('lang="en"');
    expect(html).toContain('data-layout="dock"');
    expect(html).toContain('--accent:#2f5fd0');
    expect(html).toContain('>Send</button>');
    expect(html).not.toContain('role="group"');
  });

  it('shows the title, the theme, the locale and the parts of an empty conversation', () => {
    const html = renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: DRESSED,
      }),
    );
    expect(html).toContain('>Help centre</h1>');
    expect(html).toContain('>ACME</span>');
    expect(html).toContain('lang="ja"');
    expect(html).toContain('data-layout="side"');
    expect(html).toContain('--accent:#0a7f5a');
    expect(html).toContain('>送信</button>');
    expect(html).toContain('aria-label="Support triageへのメッセージ"');
    expect(html).toContain('Ask me about your order.');
    expect(html).toContain('aria-label="おすすめの質問"');
    expect(html.match(/<button type="button"/gu)).toHaveLength(2);
    expect(html).toContain('Answers may be wrong.');
  });

  it('drops the greeting and the prompts after the first message, and keeps the disclaimer', () => {
    const run = withVisitorMessage(null, 'Support triage', 'visitor-1', 'Hello');
    const html = renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: DRESSED,
        initialRun: run,
      }),
    );
    expect(html).toContain('Hello');
    expect(html).not.toContain('Ask me about your order.');
    expect(html).not.toContain('おすすめの質問');
    expect(html).not.toContain('<button type="button"');
    expect(html).toContain('Answers may be wrong.');
  });
});

describe('Chat history, switcher, feedback and tool results (#540)', () => {
  const answered = withAssistantResponse(
    withVisitorMessage(null, 'Support triage', 'visitor-1', 'Where is my order?'),
    surfaceAgentSpeaker('Support triage'),
    { id: 'msg_1', text: ['It shipped.'] },
  );
  const turn: SurfaceTurn = {
    runId: 'run-1',
    answerIds: ['assistant-msg_1'],
    tools: [
      {
        id: 'call_1',
        name: 'lookup_order',
        input: { order: 42 },
        output: '[{"order":42,"status":"shipped"}]',
        isError: false,
      },
    ],
  };

  function render(surface: SurfaceDefinition): string {
    return renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: surface,
        initialRun: answered,
        initialTurns: [turn],
      }),
    );
  }

  it('renders the feedback buttons after the answer only when the surface asks for them', () => {
    const html = render({ ...PLAIN, parts: { feedback: true } });
    expect(html.indexOf('aria-label="Good answer"')).toBeGreaterThan(html.indexOf('It shipped.'));
    expect(html).toContain('aria-label="Bad answer"');
    expect(render(PLAIN)).not.toContain('aria-label="Good answer"');
  });

  it('renders a switcher, and still exactly one message box', () => {
    const html = render({ ...PLAIN, parts: { agentSwitcher: { agents: ['Billing'] } } });
    expect(html).toContain('<select aria-label="Agent"');
    expect(html).toContain('<option value="Support triage" selected="">');
    expect(html).toContain('<option value="Billing">');
    expect(html.match(/<textarea/gu)).toHaveLength(1);
    expect(render(PLAIN)).not.toContain('<select');
  });

  it('shows the full trace and the named tool result before the answer', () => {
    const html = render({
      ...PLAIN,
      parts: { toolTrace: 'full' },
      toolResults: { lookup_order: 'table' },
    });
    const answer = html.indexOf('It shipped.');
    expect(html.indexOf('open=""')).toBeLessThan(answer);
    expect(html).toContain('>Input</dt>');
    expect(html.indexOf('<table')).toBeGreaterThan(-1);
    expect(html.indexOf('<table')).toBeLessThan(answer);
    expect(html).toContain('>shipped</td>');
    const plain = render(PLAIN);
    expect(plain).not.toContain('<details');
    expect(plain).not.toContain('<table');
  });
});

describe('Chat keeps the composer in view (#558)', () => {
  it('renders the form and the disclaimer in the pinned composer, after the scrolling body', () => {
    const html = renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: DRESSED,
        initialRun: withVisitorMessage(null, 'Support triage', 'visitor-1', 'Hello'),
      }),
    );
    const composer = html.indexOf('data-surface-composer');
    expect(composer).toBeGreaterThan(-1);
    expect(html.indexOf('aria-live="polite"')).toBeLessThan(composer);
    expect(html.indexOf('Hello')).toBeLessThan(composer);
    expect(html.indexOf('<form')).toBeGreaterThan(composer);
    expect(html.indexOf('<textarea')).toBeGreaterThan(composer);
    expect(html.indexOf('>送信</button>')).toBeGreaterThan(composer);
    expect(html.indexOf('Answers may be wrong.')).toBeGreaterThan(composer);
    const body = html.indexOf('aw-frame-body');
    expect(body).toBeGreaterThan(-1);
    expect(body).toBeLessThan(composer);
  });

  it('renders a notice inside the frame, before the header', () => {
    const html = renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: PLAIN,
        notice: createElement('div', { role: 'alert' }, 'Runtime driver in force'),
      }),
    );
    const main = html.indexOf('<main ');
    const notice = html.indexOf('Runtime driver in force');
    expect(main).toBeGreaterThan(-1);
    expect(html.indexOf('data-surface-notice')).toBeGreaterThan(main);
    expect(notice).toBeGreaterThan(main);
    expect(notice).toBeLessThan(html.indexOf('>Support triage</h1>'));
    expect(notice).toBeLessThan(html.indexOf('</main>'));
  });
});

describe('Chat parts are replaceable, and each receives its documented props (#623)', () => {
  /** A part that records the props it was rendered with. */
  function spy<P extends object>(
    render: (props: P) => ReactNode = () => null,
  ): {
    readonly calls: P[];
    readonly Part: (props: P) => ReactNode;
  } {
    const calls: P[] = [];
    return {
      calls,
      Part: (props: P): ReactNode => {
        calls.push(props);
        return render(props);
      },
    };
  }

  it('gives a replaced Composer exactly the ComposerProps, in place of the default form', () => {
    expectTypeOf<ComposerProps>().toEqualTypeOf<{
      readonly value: string;
      readonly onChange: (value: string) => void;
      readonly onSubmit: () => void;
      readonly disabled: boolean;
      readonly canSend: boolean;
      readonly label: string;
      readonly sendLabel: string;
    }>();
    const composer = spy<ComposerProps>();
    const html = renderToStaticMarkup(
      createElement(Chat, { surface: 'main', components: { Composer: composer.Part } }),
    );
    expect(html).not.toContain('<textarea');
    expect(composer.calls).toHaveLength(1);
    const props = composer.calls[0];
    expect(Object.keys(props ?? {}).sort()).toEqual([
      'canSend',
      'disabled',
      'label',
      'onChange',
      'onSubmit',
      'sendLabel',
      'value',
    ]);
    expect(props).toMatchObject({
      value: '',
      disabled: false,
      canSend: false,
      label: 'Message main',
      sendLabel: 'Send',
    });
    expect(props?.onChange).toBeTypeOf('function');
    expect(props?.onSubmit).toBeTypeOf('function');
  });

  it('closes a replaced Composer at the turn limit, in the surface language', () => {
    const composer = spy<ComposerProps>();
    renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        definition: DRESSED,
        initialRun: withSurfaceFailure(
          withVisitorMessage(null, 'Support triage', 'visitor-1', 'こんにちは'),
          surfaceStrings('ja').turnLimitReached,
          'surface_turn_limit_reached',
        ),
        components: { Composer: composer.Part },
      }),
    );
    expect(composer.calls[0]).toMatchObject({
      disabled: true,
      canSend: false,
      label: 'Support triageへのメッセージ',
      sendLabel: '送信',
    });
  });

  it('gives a replaced MessageList, Message and ToolResult their props', () => {
    const list = spy<MessageListProps>((props) => createElement('ul', null, props.children));
    const message = spy<MessageProps>((props) => createElement('li', null, props.tools));
    const result = spy<ToolResultProps>();
    const run = withAssistantResponse(
      withVisitorMessage(null, 'Support triage', 'visitor-1', 'Where is my order?'),
      surfaceAgentSpeaker('Support triage'),
      { id: 'msg_1', text: ['It shipped.'] },
    );
    const output = '[{"order":42}]';
    const html = renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        definition: { ...PLAIN, toolResults: { lookup_order: 'table' } },
        initialRun: run,
        initialTurns: [
          {
            runId: 'run-1',
            answerIds: ['assistant-msg_1'],
            tools: [{ id: 'call_1', name: 'lookup_order', input: {}, output, isError: false }],
          },
        ],
        components: { MessageList: list.Part, Message: message.Part, ToolResult: result.Part },
      }),
    );
    expect(list.calls).toHaveLength(1);
    expect(html).toContain('<ul><li></li><li>');
    expect(html).not.toContain('aria-live="polite"');
    expect(message.calls.map((props) => Object.keys(props).sort())).toEqual([
      ['feedback', 'message', 'tools'],
      ['feedback', 'message', 'tools'],
    ]);
    expect(message.calls.map((props) => props.message.kind)).toEqual(['user', 'agent']);
    expect(message.calls[0]?.tools).toBeNull();
    expect(message.calls[1]?.feedback).toBeNull();
    expect(result.calls).toEqual([{ output, component: 'table' }]);
  });
});

describe('sendsOnEnter (BH061-036)', () => {
  const key = (
    over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }> = {},
  ) => ({
    key: over.key ?? 'Enter',
    shiftKey: over.shiftKey ?? false,
    nativeEvent: { isComposing: over.isComposing ?? false, keyCode: over.keyCode ?? 13 },
  });

  it('sends on a plain Enter', () => {
    expect(sendsOnEnter(key())).toBe(true);
  });

  it('keeps Shift+Enter, other keys and IME confirmation as typing', () => {
    expect(sendsOnEnter(key({ shiftKey: true }))).toBe(false);
    expect(sendsOnEnter(key({ key: 'a', keyCode: 65 }))).toBe(false);
    expect(sendsOnEnter(key({ isComposing: true }))).toBe(false);
    expect(sendsOnEnter(key({ keyCode: 229 }))).toBe(false);
  });
});

describe('Chat renders assistant text as Markdown and user text literally (ADR-0141, #1131)', () => {
  function render(text: readonly string[], question = 'How do I get started?'): string {
    const run = withAssistantResponse(
      withVisitorMessage(null, 'Support triage', 'visitor-1', question),
      surfaceAgentSpeaker('Support triage'),
      { id: 'msg_1', text },
    );
    return renderToStaticMarkup(
      createElement(Chat, {
        surface: 'main',
        agentName: 'Support triage',
        definition: PLAIN,
        initialRun: run,
      }),
    );
  }

  it('renders headings, bold and code blocks instead of their source', () => {
    const html = render([
      '## Quick Start Guide\n\n**1. Install dependencies:**\n\n```bash\nnpm install\n```',
    ]);
    expect(html).toContain('<h2>Quick Start Guide</h2>');
    expect(html).toContain('<strong>1. Install dependencies:</strong>');
    expect(html).toMatch(/<pre><code[^>]*>npm install\n<\/code><\/pre>/u);
    expect(html).not.toContain('**');
    expect(html).not.toContain('```');
  });

  it('renders a GFM table', () => {
    expect(render(['| a | b |\n| - | - |\n| 1 | 2 |'])).toContain('<table>');
  });

  it('drops raw HTML, images and unsafe link schemes', () => {
    const html = render([
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [y](data:text/html,<b>x</b>) ![i](https://e.x/a.png)',
    ]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('href="data:');
  });

  it('opens links outside the chat, without opener or referrer', () => {
    expect(render(['[ok](https://example.com)'])).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">ok</a>',
    );
  });

  it('keeps a user message literal', () => {
    expect(render(['Sure.'], '**x**')).toContain('<p class="aw-paragraph">**x**</p>');
  });

  it('renders a partial stream, and an unclosed fence does not swallow the next block', () => {
    expect(() => render(['```bash\nnpm i'])).not.toThrow();
    expect(render(['```js\nx', 'after **b**'])).toContain('<strong>b</strong>');
  });
});
