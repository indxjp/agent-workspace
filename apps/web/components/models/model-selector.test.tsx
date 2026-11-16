// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogModel, ModelSelectionValue } from './catalog';
import { ModelSelector, ModelUnavailableNotice } from './model-selector';

const CAPS: CatalogModel['capabilities'] = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: true,
  structuredOutput: true,
  contextManagement: true,
  webSearch: true,
  tokenCounting: true,
};

function entry(connectionId: string, connectionName: string, model: string): CatalogModel {
  return {
    connectionId,
    connectionName,
    provider: 'anthropic',
    providerModelId: model,
    displayName: model,
    capabilities: CAPS,
  };
}

// Two connections offer the same two models; a third model comes from the second only.
const MODELS = [
  entry('c1', 'Prod Anthropic', 'claude-sonnet-4-5'),
  entry('c1', 'Prod Anthropic', 'claude-haiku-4-5'),
  entry('c2', 'Team Anthropic', 'claude-sonnet-4-5'),
  entry('c2', 'Team Anthropic', 'claude-haiku-4-5'),
  entry('c2', 'Team Anthropic', 'claude-opus-4-1'),
];

function mount(value: ModelSelectionValue, inheritLabel?: string) {
  const onChange = vi.fn<(next: ModelSelectionValue) => void>();
  const container = document.createElement('div');
  document.body.append(container);
  flushSync(() => {
    createRoot(container).render(
      <ModelSelector
        id="m"
        label="Model"
        models={MODELS}
        value={value}
        onChange={onChange}
        {...(inheritLabel === undefined ? {} : { inheritLabel })}
      />,
    );
  });
  const pick = (selector: string, next: string) => {
    const select = container.querySelector<HTMLSelectElement>(selector);
    if (select === null) throw new Error(`no ${selector}`);
    select.value = next;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { container, onChange, pick };
}

function optionTexts(container: HTMLElement, selector: string): string[] {
  return [...container.querySelectorAll(`${selector} option`)].map((node) => node.textContent);
}

describe('ModelSelector', () => {
  it('lists each model once when two connections offer it (UX-22)', () => {
    const { container } = mount({ connectionId: 'c1', model: 'claude-opus-4-1' }, 'No override');
    expect(optionTexts(container, '#m')).toEqual([
      'No override',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-1',
    ]);
  });

  it('adds the model id when two different models share a display name', () => {
    const container = document.createElement('div');
    document.body.append(container);
    flushSync(() => {
      createRoot(container).render(
        <ModelSelector
          id="d"
          label="Model"
          models={[
            { ...entry('c1', 'Prod Anthropic', 'claude-sonnet-4-5'), displayName: 'Sonnet 4.5' },
            { ...entry('c2', 'Proxy', 'sonnet-4-5-proxy'), displayName: 'Sonnet 4.5' },
            entry('c2', 'Proxy', 'claude-haiku-4-5'),
          ]}
          value={null}
          onChange={() => undefined}
        />,
      );
    });
    expect(optionTexts(container, '#d')).toEqual([
      'Sonnet 4.5 (claude-sonnet-4-5)',
      'Sonnet 4.5 (sonnet-4-5-proxy)',
      'claude-haiku-4-5',
    ]);
  });

  it('asks for the connection only when more than one offers the chosen model', () => {
    const shared = mount({ connectionId: 'c2', model: 'claude-sonnet-4-5' });
    expect(optionTexts(shared.container, '#m-connection')).toEqual([
      'Prod Anthropic',
      'Team Anthropic',
    ]);
    expect(shared.container.querySelector<HTMLSelectElement>('#m-connection')?.value).toBe('c2');
    expect(shared.container.querySelector('label[for="m-connection"]')?.textContent).toBe(
      'Connection',
    );

    expect(
      mount({ connectionId: 'c2', model: 'claude-opus-4-1' }).container.querySelector(
        '#m-connection',
      ),
    ).toBeNull();
    expect(mount(null, 'No override').container.querySelector('#m-connection')).toBeNull();
  });

  it('submits the chosen connection with the model', () => {
    const { onChange, pick } = mount({ connectionId: 'c1', model: 'claude-sonnet-4-5' });
    pick('#m-connection', 'c2');
    expect(onChange).toHaveBeenLastCalledWith({ connectionId: 'c2', model: 'claude-sonnet-4-5' });
  });

  it('keeps the current connection when it offers the new model, and moves when it does not', () => {
    const kept = mount({ connectionId: 'c2', model: 'claude-sonnet-4-5' });
    kept.pick('#m', 'claude-haiku-4-5');
    expect(kept.onChange).toHaveBeenLastCalledWith({
      connectionId: 'c2',
      model: 'claude-haiku-4-5',
    });

    const moved = mount({ connectionId: 'c1', model: 'claude-sonnet-4-5' });
    moved.pick('#m', 'claude-opus-4-1');
    expect(moved.onChange).toHaveBeenLastCalledWith({
      connectionId: 'c2',
      model: 'claude-opus-4-1',
    });
  });

  it('clears to the inherited value from the top option', () => {
    const { onChange, pick } = mount({ connectionId: 'c1', model: 'claude-sonnet-4-5' }, 'Inherit');
    pick('#m', '');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('never reads a model with an empty id as the inherit option', () => {
    const onChange = vi.fn<(next: ModelSelectionValue) => void>();
    const container = document.createElement('div');
    document.body.append(container);
    flushSync(() => {
      createRoot(container).render(
        <ModelSelector
          id="e"
          label="Model"
          models={[entry('c1', 'Prod Anthropic', ''), ...MODELS]}
          value={{ connectionId: 'c1', model: 'claude-sonnet-4-5' }}
          onChange={onChange}
          inheritLabel="Inherit"
        />,
      );
    });
    const select = container.querySelector<HTMLSelectElement>('#e');
    if (select === null) throw new Error('no select');
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('ModelUnavailableNotice', () => {
  it('names every unreachable connection in a dismissible status notice', () => {
    const html = renderToStaticMarkup(
      <ModelUnavailableNotice
        unavailable={[{ connectionName: 'Anthropic', reason: 'The key was rejected' }]}
      />,
    );
    expect(html).toContain('data-testid="model-unavailable-notice"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Anthropic: The key was rejected');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('renders nothing when every connection is reachable', () => {
    expect(renderToStaticMarkup(<ModelUnavailableNotice unavailable={[]} />)).toBe('');
  });
});
