import { expect, it } from 'vitest';

import * as published from '@indx-workspace/sdk/define';

import * as source from './index.js';

// A package's own tests resolve its published specifier through `exports` — to the built
// `dist/define/index.js`, a second copy of this module — so this proves the subpath is exported
// with the same surface, and that values cross between the two copies.
it('exports @indx-workspace/sdk/define with the surface of this module', () => {
  expect(Object.keys(published).sort()).toStrictEqual(Object.keys(source).sort());

  const agent = published.defineAgent({ name: 'assistant', instructions: 'Answer briefly.' });
  const surface = source.defineSurface({ name: 'main', agent: 'assistant' });

  expect(source.isDefinedAgent(agent)).toBe(true);
  expect(published.isDefinedSurface(surface)).toBe(true);
  expect(source.toAgentVersionBody(agent, { surfaces: [surface] })).toStrictEqual(
    published.toAgentVersionBody(agent, { surfaces: [surface] }),
  );
});
