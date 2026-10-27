import { BUILDER_TOOL_FIXES } from '@indx-workspace/contracts/builder';

import { EXAMPLES, getExample } from '../examples';
import type { Executor } from './types';

/** No `aw` command serves the examples; `aw init` writes the starter project a person begins from. */
const AW_COMMAND = 'aw init';

/** The example names, and one example's body when `name` is given. */
export const examplesGet: Executor<'examples_get'> = (call) => {
  const names = EXAMPLES.map((entry) => entry.name);
  const { name } = call.input;
  if (name === undefined) return Promise.resolve({ ok: true, names, awCommand: AW_COMMAND });
  const found = getExample(name);
  if (found === undefined) {
    return Promise.resolve({
      ok: false,
      code: 'invalid_arguments',
      message: 'There is no example with that name.',
      details: ['name'],
      fix: BUILDER_TOOL_FIXES.unknownExample,
    });
  }
  return Promise.resolve({
    ok: true,
    names,
    example: { name: found.name, body: found.body },
    awCommand: AW_COMMAND,
  });
};
