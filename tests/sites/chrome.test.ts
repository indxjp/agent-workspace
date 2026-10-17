import { describe, expect, it } from 'vitest';

import { renderBlock, syncPage, syncSite } from '../../scripts/sites/chrome.mjs';

const partials = {
  head: '<link rel="stylesheet" href="assets/site.css">',
  header: '<a href="index.html">Home</a><a href="compare.html">Compare</a>',
  footer: '<footer>f</footer>',
};
const page = (header: string) =>
  [
    '<head><!-- chrome:head -->\nold\n<!-- /chrome:head --></head>',
    `<body><!-- chrome:header -->\n${header}\n<!-- /chrome:header -->`,
    '<main></main><!-- chrome:footer -->\n<!-- /chrome:footer --></body>',
  ].join('\n');

describe('marketing-site chrome sync', () => {
  it('marks only the header link to the page itself as current', () => {
    const block = renderBlock('compare.html', 'header', partials.header);
    expect(block).toContain('<a href="compare.html" aria-current="page">Compare</a>');
    expect(block).toContain('<a href="index.html">Home</a>');
    expect(renderBlock('compare.html', 'footer', '<a href="compare.html">x</a>')).not.toContain(
      'aria-current',
    );
  });

  it('rewrites every block from the partials and leaves the rest of the page alone', () => {
    const synced = syncPage('compare.html', page('stale'), partials);
    expect(synced.problems).toEqual([]);
    expect(synced.html).toContain(partials.head);
    expect(synced.html).not.toContain('stale');
    expect(synced.html).toContain('<main></main>');
    expect(syncPage('compare.html', synced.html, partials).html).toBe(synced.html);
  });

  it('refuses a page that is missing a block or carries it twice', () => {
    const missing = syncPage('a.html', '<!-- chrome:head --><!-- /chrome:head -->', partials);
    expect(missing.problems).toEqual([
      'a.html: expected one chrome:header block, found 0',
      'a.html: expected one chrome:footer block, found 0',
    ]);
    const twice = page('x') + '<!-- chrome:footer --><!-- /chrome:footer -->';
    expect(syncPage('a.html', twice, partials).problems).toEqual([
      'a.html: expected one chrome:footer block, found 2',
    ]);
  });

  it('finds the checked-in site in sync with its partials', () => {
    expect(syncSite('--check')).toEqual([]);
  });
});
