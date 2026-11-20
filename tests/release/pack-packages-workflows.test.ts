import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PUBLISHED_PACKAGES } from '../../scripts/release/pack-packages.mjs';

describe('workflows that pack the published set', () => {
  const WORKFLOWS = path.join(__dirname, '../../.github/workflows');
  const PACKS_ALL =
    /tests\/journey\/run\.mjs|build-deploy-journey\/journey\.e2e\.mjs|tests\/docs-claims\/run\.mjs|release:pack|publish-packages\.mjs/u;

  it('builds every PUBLISHED_PACKAGES member in each full-pack job that names its projects', () => {
    let checked = 0;
    let restored = 0;
    for (const file of ['ci.yml', 'journey-live.yml', 'publish-packages.yml']) {
      const jobs = readFileSync(path.join(WORKFLOWS, file), 'utf8').split(/^ {2}(?=[\w-]+:$)/mu);
      for (const job of jobs.filter(
        (text) => PACKS_ALL.test(text) && !text.includes('node tests/generated-project/run.mjs'),
      )) {
        // ci.yml's packing jobs restore the `build` job's artifact, which builds every project.
        if (job.includes('uses: ./.github/actions/workspace-build')) {
          restored += 1;
          continue;
        }
        for (const line of job.split('\n')) {
          const list = /run-many -t build (?:--projects=|-p )(\S+(?: @\S+)*)/u.exec(line)?.[1];
          if (list === undefined) continue;
          const built = list.split(/[, ]/u);
          const missing = PUBLISHED_PACKAGES.filter(
            (name) => !built.includes(`@indx-workspace/${name}`),
          );
          expect(missing, `${file} job ${job.slice(0, job.indexOf(':'))}`).toEqual([]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(restored).toBeGreaterThanOrEqual(3);
    const ci = readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8');
    // `build` builds every project but embedded, and `build-embedded` builds embedded.
    expect(ci).toMatch(
      /^ {8}run: scripts\/ci\/nx\.sh run-many -t build --exclude=@indx-workspace\/embedded --parallel=/mu,
    );
    expect(ci).toMatch(/^ {8}run: scripts\/ci\/nx\.sh run @indx-workspace\/embedded:build /mu);
  });
});
