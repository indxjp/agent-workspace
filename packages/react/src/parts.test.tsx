import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { surfaceStrings } from './locale.js';
import { ApprovalPrompt } from './approval-prompt.js';
import {
  AgentSwitcher,
  AttachmentChips,
  FeedbackButtons,
  SuggestedPrompts,
  SurfaceDisclaimer,
  SurfaceGreeting,
  SurfaceHeader,
  ToolResult,
  toolResultView,
  ToolTrace,
} from './parts.js';
import type { SurfaceToolStep } from './surface-chat-model.js';

const STEPS: readonly SurfaceToolStep[] = [
  {
    id: 's1',
    name: 'read_orders',
    input: { file: 'orders.csv' },
    output: '<b>3 rows</b>',
    isError: false,
  },
  { id: 's2', name: 'search', input: null, output: null, isError: false },
];

const ignore = (): void => undefined;

describe('the surface parts (S1-18, #456)', () => {
  it('shows the title in the header, falling back to the agent name', () => {
    expect(renderToStaticMarkup(<SurfaceHeader title="Help" agentName="Support" />)).toContain(
      '>Help</h1>',
    );
    expect(renderToStaticMarkup(<SurfaceHeader agentName="Support" />)).toContain('>Support</h1>');
  });

  it('draws a text logo as a mark and a URL logo as an image with no referrer', () => {
    const text = renderToStaticMarkup(<SurfaceHeader logo={{ text: 'ACME' }} agentName="A" />);
    expect(text).toContain('>ACME</span>');
    expect(text).not.toContain('<img');
    const image = renderToStaticMarkup(
      <SurfaceHeader logo={{ url: 'https://example.com/logo.png' }} agentName="A" />,
    );
    expect(image).toContain('src="https://example.com/logo.png"');
    expect(image).toContain('alt=""');
    expect(image).toContain('referrerPolicy="no-referrer"');
  });

  it('renders the greeting, the prompts and the disclaimer', () => {
    expect(renderToStaticMarkup(<SurfaceGreeting text="Hello there" />)).toContain('Hello there');
    const prompts = renderToStaticMarkup(
      <SuggestedPrompts
        prompts={['Track my order', 'Talk to a person']}
        label="Suggested prompts"
        disabled={false}
        onPick={ignore}
      />,
    );
    expect(prompts.match(/<button type="button"/gu)).toHaveLength(2);
    expect(prompts).toContain('aria-label="Suggested prompts"');
    expect(prompts).toContain('Track my order');
    expect(prompts).not.toContain('disabled');
    const busy = renderToStaticMarkup(
      <SuggestedPrompts prompts={['A']} label="L" disabled onPick={ignore} />,
    );
    expect(busy).toContain('disabled=""');
    const note = renderToStaticMarkup(<SurfaceDisclaimer text="AI can be wrong." label="Note" />);
    expect(note).toContain('aria-label="Note"');
    expect(note).toContain('AI can be wrong.');
  });

  it('hides the tool trace, or collapses it under a localised count', () => {
    const strings = surfaceStrings('en');
    expect(renderToStaticMarkup(<ToolTrace mode="hidden" steps={STEPS} strings={strings} />)).toBe(
      '',
    );
    expect(renderToStaticMarkup(<ToolTrace mode="collapsed" steps={[]} strings={strings} />)).toBe(
      '',
    );
    const collapsed = renderToStaticMarkup(
      <ToolTrace mode="collapsed" steps={STEPS} strings={strings} />,
    );
    expect(collapsed).toContain('<details');
    expect(collapsed).not.toContain('open=""');
    expect(collapsed).toContain('>2 tool steps</summary>');
    expect(collapsed).toContain('read_orders');
    expect(collapsed).toContain('search');
    expect(collapsed).toContain('data-state="done"');
    expect(collapsed).toContain('data-state="running"');
    expect(collapsed).not.toContain('<pre');
    const ja = renderToStaticMarkup(
      <ToolTrace mode="collapsed" steps={STEPS} strings={surfaceStrings('ja')} />,
    );
    expect(ja).toContain('ツールの実行 2 件');
  });

  it("opens the full trace with each step's input and output, as text", () => {
    const html = renderToStaticMarkup(
      <ToolTrace mode="full" steps={STEPS} strings={surfaceStrings('en')} />,
    );
    expect(html).toContain('open=""');
    expect(html).toContain('>Input</dt>');
    expect(html).toContain('{\n  &quot;file&quot;: &quot;orders.csv&quot;\n}');
    expect(html).toContain('>Output</dt>');
    expect(html).toContain('&lt;b&gt;3 rows&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    // The running step has no output yet.
    expect(html.match(/>Output<\/dt>/gu)).toHaveLength(1);
  });
});

describe('the attachment chips (R-F5a, #1489)', () => {
  const ITEMS = [
    { id: 'f1', name: 'orders.csv' },
    { id: 'f2', name: '<b>x</b>.txt' },
  ];

  it('renders one aw-chip per item, with no wrapper, and names each remove button', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips
        items={ITEMS}
        removeLabel={surfaceStrings('en').removeFile}
        onRemove={ignore}
      />,
    );
    expect(html).toBe(
      '<span class="aw-chip">orders.csv<button type="button" aria-label="Remove orders.csv">×</button></span>' +
        '<span class="aw-chip">&lt;b&gt;x&lt;/b&gt;.txt<button type="button" aria-label="Remove &lt;b&gt;x&lt;/b&gt;.txt">×</button></span>',
    );
  });

  it('takes the host look: class names, glyph and title, and a localised label', () => {
    const html = renderToStaticMarkup(
      <AttachmentChips
        items={ITEMS.slice(0, 1)}
        removeLabel={surfaceStrings('ja').removeFile}
        onRemove={ignore}
        disabled
        classNames={{ chip: 'chip-class', remove: 'remove-class' }}
        removeGlyph="✕"
        removeTitle="Remove"
      />,
    );
    expect(html).toBe(
      '<span class="chip-class">orders.csv<button type="button" aria-label="orders.csvを削除" class="remove-class" title="Remove" disabled="">✕</button></span>',
    );
  });

  it('draws no remove button when read-only, with no onRemove (#1508)', () => {
    expect(renderToStaticMarkup(<AttachmentChips items={ITEMS.slice(0, 1)} />)).toBe(
      '<span class="aw-chip">orders.csv</span>',
    );
    expect(
      renderToStaticMarkup(
        <AttachmentChips items={ITEMS.slice(0, 1)} removeLabel={String} disabled />,
      ),
    ).not.toContain('<button');
  });

  it('renders nothing for no items', () => {
    expect(
      renderToStaticMarkup(<AttachmentChips items={[]} removeLabel={String} onRemove={ignore} />),
    ).toBe('');
  });
});

describe('tool results (#540)', () => {
  it('renders a JSON array of objects as a table', () => {
    const html = renderToStaticMarkup(<ToolResult output='[{"a":1}]' component="table" />);
    expect(html).toContain('<table');
    expect(html).toContain('<th class="aw-th">a</th>');
    expect(html).toContain('<td class="aw-td">1</td>');
    expect(toolResultView('[{"a":1,"b":{"c":2}},{"d":"x"}]', 'table')).toEqual({
      kind: 'table',
      columns: ['a', 'b', 'd'],
      rows: [
        ['1', '{"c":2}', ''],
        ['', '', 'x'],
      ],
    });
  });

  it('renders a JSON object as a card', () => {
    const html = renderToStaticMarkup(
      <ToolResult output='{"status":"shipped"}' component="card" />,
    );
    expect(html).toContain('<dl');
    expect(html).toContain('<dt class="aw-card-key">status</dt><dd>shipped</dd>');
  });

  it('falls back to text for output that does not fit, or is not JSON', () => {
    const html = renderToStaticMarkup(<ToolResult output="not json" component="table" />);
    expect(html).not.toContain('<table');
    expect(html).toContain('>not json</pre>');
    expect(toolResultView('[]', 'table')).toEqual({ kind: 'text', text: '[]' });
    expect(toolResultView('[1,2]', 'table')).toEqual({ kind: 'text', text: '[1,2]' });
    expect(toolResultView('[{"a":1}]', 'card')).toEqual({ kind: 'text', text: '[{"a":1}]' });
    expect(toolResultView('{"a":1}', 'text')).toEqual({ kind: 'text', text: '{"a":1}' });
  });
});

describe('the agent switcher and the feedback buttons (#540)', () => {
  it('lists the agents with the current one selected', () => {
    const html = renderToStaticMarkup(
      <AgentSwitcher
        agents={['Support', 'Billing']}
        current="Billing"
        label="Agent"
        disabled={false}
        onSwitch={ignore}
      />,
    );
    expect(html).toContain('<select aria-label="Agent"');
    expect(html).toContain('<option value="Support">Support</option>');
    expect(html).toContain('<option value="Billing" selected="">Billing</option>');
    expect(html).not.toContain('<textarea');
  });

  it('offers both ratings, then disables them and marks the one given', () => {
    const strings = surfaceStrings('en');
    const open = renderToStaticMarkup(
      <FeedbackButtons rated={null} failed={false} strings={strings} onRate={ignore} />,
    );
    expect(open.match(/<button type="button"/gu)).toHaveLength(2);
    expect(open).toContain('aria-label="Good answer"');
    expect(open).toContain('aria-label="Bad answer"');
    expect(open).not.toContain('disabled=""');
    const rated = renderToStaticMarkup(
      <FeedbackButtons rated="up" failed strings={strings} onRate={ignore} />,
    );
    expect(rated.match(/disabled=""/gu)).toHaveLength(2);
    expect(rated).toContain('aria-label="Good answer" aria-pressed="true"');
    expect(rated).toContain('aria-label="Bad answer" aria-pressed="false"');
    expect(rated).toContain('The rating could not be sent.');
  });
});

describe('the approval prompt (#1490, ADR-0145)', () => {
  const call = { toolName: 'send_mail', canonicalCall: '{"to":"<b>boss</b>"}' };

  it('names the tool and shows the canonical call as text, never as markup', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt
        call={call}
        strings={surfaceStrings('en')}
        pending={false}
        onDecide={ignore}
      />,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="The agent is waiting for your approval to use send_mail"');
    expect(html).toContain('{&quot;to&quot;:&quot;&lt;b&gt;boss&lt;/b&gt;&quot;}');
    expect(html).not.toContain('<b>boss</b>');
  });

  it('shows a shell command alone, with the full call one click away (#2091 follow-up)', () => {
    const shell = {
      toolName: 'Bash',
      canonicalCall:
        '{"input":{"command":"rm -rf <b>x</b>","description":"Tidy up"},"name":"Bash"}',
    };
    const en = renderToStaticMarkup(
      <ApprovalPrompt
        call={shell}
        strings={surfaceStrings('en')}
        pending={false}
        onDecide={ignore}
      />,
    );
    expect(en).toContain('<pre class="aw-pre aw-approval-call">rm -rf &lt;b&gt;x&lt;/b&gt;</pre>');
    expect(en).toMatch(
      /<details class="aw-approval-full-call"><summary>Full call<\/summary><pre class="aw-pre aw-approval-call">\{&quot;input&quot;.*Tidy up.*<\/pre><\/details>/u,
    );
    expect(en).not.toContain('<b>x</b>');
    expect(en).not.toMatch(/<details[^>]* open/u);
    const ja = renderToStaticMarkup(
      <ApprovalPrompt
        call={shell}
        strings={surfaceStrings('ja')}
        pending={false}
        onDecide={ignore}
      />,
    );
    expect(ja).toContain('<summary>呼び出しの全文</summary>');
    // A host that builds its own strings, without the newer label, still gets one.
    const english = surfaceStrings('en');
    const ownStrings = {
      approvalNeeded: english.approvalNeeded,
      approve: english.approve,
      reject: english.reject,
      approvalComment: english.approvalComment,
    };
    expect(
      renderToStaticMarkup(
        <ApprovalPrompt call={shell} strings={ownStrings} pending={false} onDecide={ignore} />,
      ),
    ).toContain('<summary>Full call</summary>');
  });

  it('shows any other call in full, with nothing folded away', () => {
    const write = {
      toolName: 'Write',
      canonicalCall: '{"input":{"content":"hi","file_path":"a.md"},"name":"Write"}',
    };
    const html = renderToStaticMarkup(
      <ApprovalPrompt
        call={write}
        strings={surfaceStrings('en')}
        pending={false}
        onDecide={ignore}
      />,
    );
    expect(html).not.toContain('<details');
    expect(html).toContain('&quot;file_path&quot;: &quot;a.md&quot;');
    expect(html).toContain('&quot;content&quot;: &quot;hi&quot;');
  });

  it('gives both decisions accessible names in each language, and caps the comment', () => {
    const en = renderToStaticMarkup(
      <ApprovalPrompt
        call={call}
        strings={surfaceStrings('en')}
        pending={false}
        onDecide={ignore}
      />,
    );
    expect(en).toContain('>Approve</button>');
    expect(en).toContain('>Reject</button>');
    expect(en).toContain('maxLength="1000"');
    const ja = renderToStaticMarkup(
      <ApprovalPrompt
        call={call}
        strings={surfaceStrings('ja')}
        pending={false}
        onDecide={ignore}
      />,
    );
    expect(ja).toContain('>承認</button>');
    expect(ja).toContain('>却下</button>');
  });

  it('disables both decisions and the comment while one is in flight', () => {
    const idle = renderToStaticMarkup(
      <ApprovalPrompt
        call={call}
        strings={surfaceStrings('en')}
        pending={false}
        onDecide={ignore}
      />,
    );
    expect(idle).not.toContain('disabled');
    const busy = renderToStaticMarkup(
      <ApprovalPrompt call={call} strings={surfaceStrings('en')} pending onDecide={ignore} />,
    );
    expect(busy.match(/disabled=""/gu)).toHaveLength(3);
  });

  it('shows a refusal as an alert, and nothing when there is none', () => {
    const quiet = renderToStaticMarkup(
      <ApprovalPrompt
        call={call}
        strings={surfaceStrings('en')}
        pending={false}
        onDecide={ignore}
      />,
    );
    expect(quiet).not.toContain('role="alert"');
    const refused = renderToStaticMarkup(
      <ApprovalPrompt
        call={call}
        strings={surfaceStrings('en')}
        pending={false}
        problem="This request has already been decided."
        onDecide={ignore}
      />,
    );
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('This request has already been decided.');
  });

  it('uses the host classes in place of the aw- ones when given', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt
        call={call}
        strings={surfaceStrings('en')}
        pending={false}
        onDecide={ignore}
        classNames={{ root: 'host-root', button: 'host-button', approve: 'host-approve' }}
      />,
    );
    expect(html).toContain('class="host-root"');
    expect(html).toContain('class="host-approve"');
    expect(html).toContain('class="host-button"');
    expect(html).not.toContain('aw-approval-button');
  });

  it('lets a host style every element, so a host without styles.css needs no aw- class', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt
        call={call}
        strings={surfaceStrings('en')}
        pending={false}
        problem="Refused."
        onDecide={ignore}
        classNames={{
          root: 'r',
          heading: 'h',
          call: 'c',
          label: 'l',
          comment: 'm',
          actions: 'a',
          button: 'b',
          approve: 'p',
          problem: 'x',
        }}
      />,
    );
    expect(html).not.toContain('aw-');
  });
});
