import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { surfaceStrings } from './locale.js';
import {
  AgentSwitcher,
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
