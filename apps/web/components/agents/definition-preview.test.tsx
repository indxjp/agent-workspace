// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { DefinitionPreview } from './definition-preview';
import { definitionBody } from './definition-fixture';
import { DEFINITION_SECTIONS, type DefinitionSection } from '@indx-workspace/sdk/portable';

const BEFORE = definitionBody();
const AFTER = definitionBody({
  agent: {
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  },
});

function mount(
  previous: typeof BEFORE | null,
  onAskBuilder: (section: DefinitionSection) => void = () => undefined,
) {
  const container = document.createElement('div');
  document.body.append(container);
  flushSync(() => {
    createRoot(container).render(
      <DefinitionPreview body={AFTER} previous={previous} onAskBuilder={onAskBuilder} />,
    );
  });
  return container;
}

function section(container: HTMLElement, name: DefinitionSection): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-section="${name}"]`);
  if (found === null) throw new Error(`no ${name} section rendered`);
  return found;
}

describe('DefinitionPreview', () => {
  it('highlights a changed permission and labels it', () => {
    const permissions = section(mount(BEFORE), 'permissions');
    expect(permissions.dataset['changed']).toBe('true');
    expect(permissions.className).toContain('bg-accent-soft');
    // The meaning is in words, so it survives a colour-blind reader and forced-colours mode.
    expect(permissions.textContent).toContain('changed');
    expect(permissions.querySelector('p')?.textContent).toBe('changedWrite files');
  });

  it('leaves every unchanged section plain', () => {
    const container = mount(BEFORE);
    for (const name of DEFINITION_SECTIONS.filter((candidate) => candidate !== 'permissions')) {
      const plain = section(container, name);
      expect(plain.dataset['changed']).toBeUndefined();
      expect(plain.className).not.toContain('bg-accent-soft');
      expect(plain.textContent).not.toContain('changed');
    }
  });

  it('marks every section changed when there is no previous body', () => {
    const container = mount(null);
    expect(section(container, 'instructions').dataset['changed']).toBe('true');
  });

  it('shows the model connection when no model is named', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const body = definitionBody({ agent: { model: null, modelConnectionName: 'anthropic' } });
    flushSync(() => {
      createRoot(container).render(
        <DefinitionPreview body={body} previous={body} onAskBuilder={() => undefined} />,
      );
    });
    const model = section(container, 'model');
    expect(model.textContent).toContain('anthropic');
    expect(model.textContent).toContain('Deployment default');
  });

  it('renders no form controls and no text area', () => {
    const container = mount(BEFORE);
    expect(container.querySelector('input, select, textarea')).toBeNull();
  });

  it('asks the Builder about the section whose button was pressed', () => {
    const onAskBuilder = vi.fn();
    const button = section(mount(BEFORE, onAskBuilder), 'permissions').querySelector('button');
    button?.click();
    expect(button?.textContent).toBe('Ask the Builder to change this');
    expect(onAskBuilder).toHaveBeenCalledExactlyOnceWith('permissions');
  });

  it('highlights a dangerous tool policy change under Tool policy', () => {
    const { policy } = AFTER.definition;
    if (!('tools' in policy)) throw new Error('the fixture is a tool-rules policy');
    const skipping = definitionBody();
    const tools = { ...policy.tools, allowDangerouslySkipPermissions: true };
    const body = {
      ...skipping,
      definition: { ...skipping.definition, policy: { ...policy, tools } },
    };
    const container = document.createElement('div');
    document.body.append(container);
    flushSync(() => {
      createRoot(container).render(
        <DefinitionPreview body={body} previous={BEFORE} onAskBuilder={() => undefined} />,
      );
    });
    const changed = section(container, 'policy');
    expect(changed.dataset['changed']).toBe('true');
    expect(changed.textContent).toContain('Skip permission checks: Yes');
  });
});
