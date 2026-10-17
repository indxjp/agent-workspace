import { expect, it } from 'vitest';

import * as published from '@indx-workspace/sdk/project';

import * as source from './index.js';

// A package's own tests resolve its published specifier through `exports` — to the built
// `dist/project/index.js`, a second copy of this module — so this proves the subpath is exported
// with the same surface, and that the copies render the same files.
it('exports @indx-workspace/sdk/project with the surface of this module', () => {
  expect(Object.keys(published).sort()).toStrictEqual(Object.keys(source).sort());
  expect(
    published.renderProjectShell({ name: 'my-project', version: '0.3.0', engine: 'pi' }),
  ).toStrictEqual(
    source.renderProjectShell({ name: 'my-project', version: '0.3.0', engine: 'pi' }),
  );
});
