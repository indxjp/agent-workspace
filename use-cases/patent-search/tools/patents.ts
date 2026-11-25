import { definePublicSource, publicSourceTool } from '@indx-workspace/sdk/define';

import snapshot from '../data/patents.snapshot.json' with { type: 'json' };

// Patent publications through the platform's public-source tool (ADR-0170): the demo and the evals
// read the fictional dated snapshot, with no network. The live office data needs a key (G4b).
export const patents = definePublicSource({ mode: 'snapshot', snapshot });

export default publicSourceTool({
  name: 'search_patents',
  description: 'Patent publications: title, abstract, applicant, dates, class, status.',
  source: patents,
  run: './patents.run.ts',
});
