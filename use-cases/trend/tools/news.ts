import { definePublicSource, publicSourceTool } from '@indx-workspace/sdk/define';

import snapshot from '../data/news.snapshot.json' with { type: 'json' };

// Public news articles and organisations' public posts, read through the platform's public-source
// tool (ADR-0170). The demo and the evals read the fictional dated snapshot and have no network; an
// installer adds the news and post feeds as `feeds` and sets `mode: 'live'`.
export const news = definePublicSource({ mode: 'snapshot', snapshot });

export default publicSourceTool({
  name: 'read_public_news',
  description: "Public news articles and organisations' public posts, with their dates.",
  source: news,
  run: './news.run.ts',
});
