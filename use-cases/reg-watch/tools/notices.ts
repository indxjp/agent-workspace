import { definePublicSource, publicSourceTool } from '@indx-workspace/sdk/define';

import snapshot from '../data/notices.snapshot.json' with { type: 'json' };

// Public notices of amended laws and guidelines, read through the platform's public-source tool
// (ADR-0170). The demo and the evals read the fictional dated snapshot and have no network; an
// installer adds the regulators' feeds as `feeds` and sets `mode: 'live'`.
export const notices = definePublicSource({ mode: 'snapshot', snapshot });

export default publicSourceTool({
  name: 'read_reg_notices',
  description: 'Public notices of amended laws, guidelines and consultations, with their dates.',
  source: notices,
  run: './notices.run.ts',
});
