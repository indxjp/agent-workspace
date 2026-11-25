import { definePublicSource, publicSourceTool } from '@indx-workspace/sdk/define';

import snapshot from '../data/sources.snapshot.json' with { type: 'json' };

// The public releases on the topic, through the platform's public-source tool (ADR-0170): the demo
// and the evals read the fictional dated snapshot, with no network. An installer adds the real
// news feeds as `feeds` and sets `mode: 'live'`.
export const sources = definePublicSource({ mode: 'snapshot', snapshot });

export default publicSourceTool({
  name: 'read_digest_sources',
  description: 'Public releases, statistics and reports on the research topic, with dates.',
  source: sources,
  run: './sources.run.ts',
});
