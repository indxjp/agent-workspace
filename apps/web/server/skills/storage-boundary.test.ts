import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const server = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(join(server, dir))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `${dir}/${name}`);
}

describe('the skills domain and the compose loader reach object storage through the catalog service', () => {
  it('design §07 rule 3, slice 1: no import of the object-storage barrel', () => {
    const barrel = /['"]@agent-workspace\/core\/storage['"]/;
    const offenders = [...sources('skills'), 'compose/resource-loader.ts'].filter((file) =>
      barrel.test(readFileSync(join(server, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
