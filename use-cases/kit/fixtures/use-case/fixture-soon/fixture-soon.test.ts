/**
 * `describeUseCase` on the kit's coming-soon fixture: no code beyond its definition, so it lists no
 * flow, and no recording yet.
 */
import { fileURLToPath } from 'node:url';

import { defineEntry } from '../../../../../examples/store/catalog/define.ts';
import { describeUseCase } from '../../../describe-use-case.ts';
import soonAgent from './agents/fixture-soon.ts';

describeUseCase('fixture-soon', {
  dir: fileURLToPath(new URL('.', import.meta.url)),
  definitions: { 'agents/fixture-soon.ts': soonAgent },
  catalog: [
    defineEntry({
      slug: 'fixture-soon',
      area: 'mfg',
      status: 'soon',
      wave: 2,
      name: { ja: '準備中', en: 'Soon' },
      summary: { ja: '準備中。', en: 'Coming.' },
    }),
  ],
  recordings: [],
});
