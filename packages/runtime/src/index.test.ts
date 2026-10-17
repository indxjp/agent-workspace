import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';
import type { RuntimeProfile } from './index.js';

describe('@agent-workspace/runtime', () => {
  it('is wired into the pnpm workspace', () => {
    expect(PACKAGE_NAME).toBe('@agent-workspace/runtime');
  });

  it('exports RuntimeProfile (§15.1) from the barrel, not only from types.ts', () => {
    // `RuntimeProfile` is a type: it does not exist at run time, so the only way to prove the
    // barrel re-exports it — rather than only `./types.js` doing so — is a type-only import from
    // `./index.js` (above) that the compiler accepts, plus a value that satisfies the imported
    // type. If `export * from './types.js';` were removed from `index.ts`, the import above would
    // fail to typecheck and this file would fail `pnpm typecheck`, which is what this test is
    // actually pinned on; the runtime assertion below is what makes it a test `vitest` also runs.
    const profile: RuntimeProfile = {
      id: 'profile-1',
      name: 'Standard',
      driver: 'docker',
      networkPolicy: 'restricted',
      filesystem: 'read-write',
    };
    expect(profile.driver).toBe('docker');
  });
});
