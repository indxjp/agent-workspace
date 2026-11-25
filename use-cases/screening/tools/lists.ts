import { definePublicSource, publicSourceTool } from '@indx-workspace/sdk/define';

import snapshot from '../data/lists.snapshot.json' with { type: 'json' };

// The public restricted-party lists, read through the platform's public-source tool (ADR-0170).
// The demo and the evals read the fictional dated snapshot and have no network. An installer adds
// the real lists as `feeds` (CSV or JSON records, with a mapping) and sets `mode: 'live'`.
export const lists = definePublicSource({ mode: 'snapshot', snapshot });

export default publicSourceTool({
  name: 'check_public_lists',
  description:
    'Public restricted-party lists: each listed company or person with its aliases, country, list and listing date.',
  source: lists,
  run: './lists.run.ts',
});
