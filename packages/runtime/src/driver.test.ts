import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createAcaSessionsCapabilities } from './aca-sessions.js';
import { cloudflareSandboxRuntimeCapabilities } from './cloudflare-sandbox.js';
import { CLOUD_RUN_RUNTIME_CAPABILITIES } from './cloud-run.js';
import { DOCKER_PROXIED_RUNTIME_CAPABILITIES, DOCKER_RUNTIME_CAPABILITIES } from './docker.js';
import type { RuntimeCapabilities } from './driver.js';
import { e2bRuntimeCapabilities } from './external/e2b.js';
import { KUBERNETES_RUNTIME_CAPABILITIES } from './kubernetes.js';
import { LOCAL_RUNTIME_CAPABILITIES } from './local.js';
import { vercelSandboxRuntimeCapabilities } from './vercel-sandbox.js';

// @story US-STO-06
const here = fileURLToPath(new URL('.', import.meta.url));

/** Every capability object a driver module exports, by `<module>#<export>`. */
const CAPABILITIES: Readonly<Record<string, RuntimeCapabilities>> = {
  'aca-sessions#createAcaSessionsCapabilities': createAcaSessionsCapabilities('EgressEnabled'),
  'cloudflare-sandbox#cloudflareSandboxRuntimeCapabilities': cloudflareSandboxRuntimeCapabilities(),
  'cloud-run#CLOUD_RUN_RUNTIME_CAPABILITIES': CLOUD_RUN_RUNTIME_CAPABILITIES,
  'docker#DOCKER_RUNTIME_CAPABILITIES': DOCKER_RUNTIME_CAPABILITIES,
  'docker#DOCKER_PROXIED_RUNTIME_CAPABILITIES': DOCKER_PROXIED_RUNTIME_CAPABILITIES,
  'external/e2b#e2bRuntimeCapabilities': e2bRuntimeCapabilities(),
  'kubernetes#KUBERNETES_RUNTIME_CAPABILITIES': KUBERNETES_RUNTIME_CAPABILITIES,
  'local#LOCAL_RUNTIME_CAPABILITIES': LOCAL_RUNTIME_CAPABILITIES,
  'vercel-sandbox#vercelSandboxRuntimeCapabilities': vercelSandboxRuntimeCapabilities(),
};

/** What the driver sources export as capability objects: `src/*.ts` and `src/external/*.ts`. */
function exportedCapabilityNames(): string[] {
  const names: string[] = [];
  for (const directory of ['', 'external']) {
    for (const file of readdirSync(join(here, directory))) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.d.ts')) continue;
      const source = readFileSync(join(here, directory, file), 'utf8');
      const module = `${directory === '' ? '' : `${directory}/`}${file.replace(/\.ts$/u, '')}`;
      for (const match of source.matchAll(
        /^export (?:const|function) (\w*(?:_RUNTIME_CAPABILITIES|Capabilities))\b/gmu,
      )) {
        names.push(`${module}#${match[1] ?? ''}`);
      }
    }
  }
  return names.sort();
}

describe('RuntimeCapabilities', () => {
  it('[unit] every driver declares how files reach it', () => {
    // A new capability object fails here until it is listed above, and so checked below.
    expect(exportedCapabilityNames()).toEqual(Object.keys(CAPABILITIES).sort());
    for (const [name, capabilities] of Object.entries(CAPABILITIES)) {
      expect(capabilities.fileTransfer, name).toBe(
        name === 'local#LOCAL_RUNTIME_CAPABILITIES' ? 'local-disk' : 'push-archive',
      );
    }
  });
});
