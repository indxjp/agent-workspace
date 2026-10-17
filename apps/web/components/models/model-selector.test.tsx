import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ModelUnavailableNotice } from './model-selector';

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
