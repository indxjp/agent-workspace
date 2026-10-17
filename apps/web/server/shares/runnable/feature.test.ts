import { describe, expect, it } from 'vitest';

import { runnablePublicLinksEnabled } from './feature';

describe('D-06 runnable public-link gate', () => {
  it('is disabled by default and ignores truthy-looking values', () => {
    expect(runnablePublicLinksEnabled({})).toBe(false);
    expect(runnablePublicLinksEnabled({ AW_ENABLE_RUNNABLE_PUBLIC_LINKS: '1' })).toBe(false);
    expect(runnablePublicLinksEnabled({ AW_ENABLE_RUNNABLE_PUBLIC_LINKS: 'TRUE' })).toBe(false);
  });

  it('cannot be enabled by the legacy environment switch', () => {
    expect(runnablePublicLinksEnabled({ AW_ENABLE_RUNNABLE_PUBLIC_LINKS: 'true' })).toBe(false);
  });
});
