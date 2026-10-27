import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BuiltinBadge } from './builtin-badge';

describe('BuiltinBadge', () => {
  it('says Built-in for a built-in agent and renders nothing for any other', () => {
    expect(renderToStaticMarkup(<BuiltinBadge builtin="builder" />)).toContain('Built-in');
    expect(renderToStaticMarkup(<BuiltinBadge builtin={undefined} />)).toBe('');
  });
});
