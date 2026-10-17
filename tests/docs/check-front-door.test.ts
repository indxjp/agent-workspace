import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkFrontDoor,
  findApostropheAnchors,
  findOrphanPages,
  findPublicSiteIssues,
  findReflowedInfoLists,
  findStaleClaims,
} from '../../scripts/docs/check-front-door.mjs';

const page = (text: string) => [{ path: 'quickstart.mdx', text }];

describe('front-door stale-claim check', () => {
  it('flags "not published" and older package versions', () => {
    const issues = findStaleClaims(
      page('line one\nIt is not published yet.\nnpm i @indx-workspace/aw@0.2.1 and 0.1.x'),
      '0.3.0',
    );
    expect(issues).toHaveLength(3);
    expect(issues[0]).toContain('quickstart.mdx:2');
  });

  it('flags the base quickstart wording', () => {
    const issues = findStaleClaims(
      page(
        '`npm create @indx-workspace@latest` installs 0.2.1, which has no `--yes`, and\n`@indx-workspace/embedded` is not on npm yet.',
      ),
      '0.3.0',
    );
    expect(issues).toEqual([
      expect.stringContaining('quickstart.mdx:1: names installs 0.2.1'),
      expect.stringContaining('quickstart.mdx:2: says "not on npm"'),
    ]);
  });

  it('accepts the release line and newer versions', () => {
    expect(
      findStaleClaims(page('@indx-workspace/aw@0.3.0, @indx-workspace/sdk@0.4'), '0.3.0'),
    ).toEqual([]);
  });

  it('flags links a public visitor cannot open and promises of shipped features', () => {
    const issues = findPublicSiteIssues([
      {
        path: 'a.mdx',
        text: 'ok\nsee [x](https://github.com/INDXDev/repo) and `docs/spec.md`\ncoming in 0.4.0',
      },
    ]);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toContain('a.mdx:2');
  });

  it('flags a link that drops an apostrophe the site keeps in the anchor (BH061-060)', () => {
    const issues = findApostropheAnchors([
      {
        path: 'docs/sdk/site/guides/deploy.mdx',
        text: [
          "## Where the deployment's state lives",
          '[a](#where-the-deployments-state-lives)',
          '[b](#where-the-deployment’s-state-lives)',
        ].join('\n'),
      },
      {
        path: 'docs/sdk/site/index.mdx',
        text: '[c](/guides/deploy#where-the-deployments-state-lives)',
      },
    ]);
    expect(issues).toEqual([
      expect.stringContaining('deploy.mdx:2'),
      expect.stringContaining('index.mdx:1'),
    ]);
  });

  it('flags an <Info> list item joined to the line before (BH061-075)', () => {
    const text = [
      '<Info>',
      '  - **Read this when:** you need it. - **You will learn:** the rest.',
      '</Info>',
      'A sentence - **bold** outside the box.',
      '<Info>',
      '',
      '- **Read this when:** you need it.',
      '- **You will learn:** the rest.',
      '',
      '</Info>',
    ].join('\n');
    expect(findReflowedInfoLists([{ path: 'a.mdx', text }])).toEqual([
      expect.stringContaining('a.mdx:2'),
    ]);
  });

  it('flags a page the navigation does not list', () => {
    expect(findOrphanPages(['a', 'b'], ['a'])).toEqual(['b: not in docs.json navigation']);
  });

  it('passes on this repository', async () => {
    expect(await checkFrontDoor(path.resolve(import.meta.dirname, '../..'))).toEqual([]);
  });
});
