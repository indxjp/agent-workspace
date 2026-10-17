import { describe, expect, it } from 'vitest';

import * as agents from './agents.js';
import golden from './__golden__/agents-exports.json' with { type: 'json' };

// The golden was captured from the built module before agents.ts was split into agents/* (#953).
describe('@indx-workspace/contracts/agents runtime surface', () => {
  it('exports exactly the names it exported before the split', () => {
    expect(Object.keys(agents).sort()).toEqual(golden);
  });
});
