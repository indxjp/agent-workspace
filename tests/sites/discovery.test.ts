import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoveryFiles, frontmatter, siteDiscoveryFiles } from '../../scripts/sites/discovery.mjs';

const manifest = {
  name: 'Docs',
  description: 'About the docs.',
  navigation: {
    tabs: [{ tab: 'Documentation', groups: [{ group: 'Start', pages: ['index', 'a/b'] }] }],
  },
};

describe('docs site discovery files (BH061-060)', () => {
  it('lists the navigation pages, not tab or group names, in all three files', () => {
    const files = discoveryFiles(manifest, (page) => ({ title: `T ${page}`, description: '' }));
    expect(files['sitemap.xml']).toContain('<loc>https://docs.agentworkspace.indx.jp/</loc>');
    expect(files['sitemap.xml']).toContain('<loc>https://docs.agentworkspace.indx.jp/a/b</loc>');
    expect(files['sitemap.xml']).not.toContain('Start');
    expect(files['robots.txt']).toContain(
      'Sitemap: https://docs.agentworkspace.indx.jp/sitemap.xml',
    );
    expect(files['llms.txt']).toBe(
      '# Docs\n\n> About the docs.\n\n## Pages\n\n' +
        '- [T index](https://docs.agentworkspace.indx.jp/)\n' +
        '- [T a/b](https://docs.agentworkspace.indx.jp/a/b)\n',
    );
  });

  it('reads a quoted title and description from frontmatter', () => {
    expect(frontmatter('---\ntitle: "Quickstart"\ndescription: "First run."\n---\n# x')).toEqual({
      title: 'Quickstart',
      description: 'First run.',
    });
  });

  it('builds from this repository: every listed page exists and has a title', () => {
    const files = siteDiscoveryFiles(path.resolve(import.meta.dirname, '../../docs/sdk/site'));
    expect(files['llms.txt']).toContain(
      '[Quickstart](https://docs.agentworkspace.indx.jp/getting-started/quickstart)',
    );
    expect(files['llms.txt']).not.toMatch(/- \[\]/u);
  });
});
