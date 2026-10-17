import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EmbeddedBuildError } from './errors.ts';
import { isDevelopmentOnly, packageNames, vendoredTarget } from './vendor-next.ts';

const store = path.resolve('/repo/node_modules/.pnpm');
const next = path.join(store, 'next@16.3.8', 'node_modules', 'next');
const react = path.join(store, 'react@19.3.0', 'node_modules', 'react');
const packages = new Map([
  [next, 'next'],
  [react, 'react'],
]);
const out = path.resolve('/out/dist/node_modules');

describe('isDevelopmentOnly', () => {
  it.each(['x/app-page.runtime.dev.js', 'x/server.runtime.prod.js.map', 'x/next.js.map'])(
    'leaves out %s',
    (file) => {
      expect(isDevelopmentOnly(file)).toBe(true);
    },
  );

  it.each(['x/app-page.runtime.prod.js', 'x/next.js', 'x/package.json'])('keeps %s', (file) => {
    expect(isDevelopmentOnly(file)).toBe(false);
  });
});

describe('vendoredTarget', () => {
  it('places a file of a vendored package under its name, keeping its path in the package', () => {
    const file = path.join(next, 'dist', 'server', 'next.js');
    expect(vendoredTarget(file, packages, out)).toBe(
      path.join(out, 'next', 'dist', 'server', 'next.js'),
    );
  });

  it('places nothing outside a vendored package, or development-only', () => {
    expect(
      vendoredTarget(path.join(store, 'pg@8', 'node_modules', 'pg', 'index.js'), packages, out),
    ).toBeUndefined();
    // A sibling whose directory only starts with a vendored one's is not inside it.
    expect(vendoredTarget(`${react}-dom${path.sep}index.js`, packages, out)).toBeUndefined();
    expect(
      vendoredTarget(path.join(next, 'dist', 'a.runtime.dev.js'), packages, out),
    ).toBeUndefined();
  });
});

describe('packageNames', () => {
  it('names each vendored package once', () => {
    expect([...packageNames(packages)]).toStrictEqual(['next', 'react']);
  });

  it('refuses one package needed at two versions', () => {
    const twice = new Map([
      ...packages,
      [path.join(store, 'react@18.0.0', 'node_modules', 'react'), 'react'],
    ]);
    expect(() => packageNames(twice)).toThrow(EmbeddedBuildError);
  });
});
