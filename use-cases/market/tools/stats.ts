import { definePublicSource, publicSourceTool } from '@indx-workspace/sdk/define';

import snapshot from '../data/stats.snapshot.json' with { type: 'json' };

// Public market statistics through the platform's public-source tool (ADR-0170): the demo and the
// evals read the fictional dated snapshot, with no network. The live statistics need a key (G4b).
export const stats = definePublicSource({ mode: 'snapshot', snapshot });

export default publicSourceTool({
  name: 'read_market_stats',
  description: 'Public statistics and industry releases on the market: figures, periods, shares.',
  source: stats,
  run: './stats.run.ts',
});
