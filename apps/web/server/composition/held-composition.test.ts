import { afterEach, describe, expect, it } from 'vitest';

import { closeHeldComposition, holdComposition } from './held-composition';

describe('held composition (S1-25, #510)', () => {
  afterEach(async () => {
    await closeHeldComposition();
  });

  it('resolves at once when nothing is held', async () => {
    await expect(closeHeldComposition()).resolves.toBeUndefined();
  });

  it('closes what is held once and then forgets it', async () => {
    let closes = 0;
    holdComposition({
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    });
    await closeHeldComposition();
    await closeHeldComposition();
    expect(closes).toBe(1);
  });

  it('keeps the handle under a registered symbol, which every bundled copy shares', () => {
    const composition = { close: () => Promise.resolve() };
    holdComposition(composition);
    expect(Reflect.get(globalThis, Symbol.for('indx.aw.web.held-composition'))).toBe(composition);
  });
});
