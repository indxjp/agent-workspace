import { definePublicSource, publicSourceTool } from '@indx-workspace/sdk/define';

import snapshot from '../data/releases.snapshot.json' with { type: 'json' };

// Competitors' public releases and price pages, read through the platform's public-source tool
// (ADR-0170). The demo and the evals read the fictional dated snapshot and have no network; an
// installer adds the competitors' news feeds as `feeds` and sets `mode: 'live'`.
export const releases = definePublicSource({ mode: 'snapshot', snapshot });

export default publicSourceTool({
  name: 'read_competitor_news',
  description: "Competitors' public releases: price changes, new features and news, with dates.",
  source: releases,
  run: './releases.run.ts',
});
