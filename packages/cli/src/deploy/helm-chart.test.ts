import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SHIPPED = fileURLToPath(new URL('../../modules/helm/agent-workspace/', import.meta.url));
const PLATFORM = fileURLToPath(new URL('../../../../infra/helm/agent-workspace/', import.meta.url));

/** Every file beneath `directory`, as sorted paths relative to it. */
async function files(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe('the Helm chart shipped with the CLI (BH061-031)', () => {
  it('is byte-identical to infra/helm/agent-workspace, file for file', async () => {
    const platform = await files(PLATFORM);
    expect(await files(SHIPPED)).toEqual(platform);
    expect(platform).toContain('Chart.yaml');
    for (const name of platform) {
      const shipped = await readFile(path.join(SHIPPED, name));
      const original = await readFile(path.join(PLATFORM, name));
      expect(shipped.equals(original), `${name} drifted from infra/helm/agent-workspace`).toBe(
        true,
      );
    }
  });
});
