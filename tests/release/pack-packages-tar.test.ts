import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { checkDistContents, readTar, verifyTarball } from '../../scripts/release/pack-packages.mjs';

import { packed, paxRecord, tarEntry } from './pack-packages.test-support.js';

describe('the scope check on compiled files', () => {
  it('refuses the third-party scope in a dist/web file of the embedded runtime', () => {
    const contents = new Map([
      ['package/dist/bin.js', Buffer.from('#!/usr/bin/env node\n')],
      [
        'package/dist/web/.next-embedded/server/chunks/ssr/a.js',
        Buffer.from('require("@agent-workspace/core")'),
      ],
    ]);
    expect(checkDistContents(contents)).toEqual([
      'package/dist/web/.next-embedded/server/chunks/ssr/a.js names @agent-workspace/*, a scope a third party owns on npm',
    ]);
  });

  it('refuses the third-party scope in any compiled dist/ file', () => {
    const contents = new Map([
      ['package/package.json', Buffer.from('{"name":"@indx-workspace/sdk"}')],
      ['package/dist/index.js', Buffer.from("export * from '@indx-workspace/contracts';")],
      ['package/dist/lazy.d.ts', Buffer.from("import type { X } from '@agent-workspace/sdk';")],
    ]);
    expect(checkDistContents(contents)).toEqual([
      'package/dist/lazy.d.ts names @agent-workspace/*, a scope a third party owns on npm',
    ]);
  });

  it('refuses the third-party scope in a template the generator copies into a project', () => {
    const contents = new Map([
      [
        'package/templates/package.json',
        Buffer.from('{"dependencies":{"@agent-workspace/cli":"0.1.0"}}'),
      ],
      ['package/templates/compose.yaml', Buffer.from('services: {}')],
    ]);
    expect(checkDistContents(contents)).toEqual([
      'package/templates/package.json names @agent-workspace/*, a scope a third party owns on npm',
    ]);
  });
});

describe('reading a tar archive', () => {
  it('reads the entries of a tar archive and keeps only the selected contents', () => {
    const archive = Buffer.concat([
      tarEntry('package/package.json', '{"name":"x"}'),
      tarEntry('package/dist/index.js', '#!/usr/bin/env node\n'),
      Buffer.alloc(1024),
    ]);
    const { names, contents } = readTar(archive, (name) => name.endsWith('.json'));
    expect(names).toEqual(['package/package.json', 'package/dist/index.js']);
    expect(contents.get('package/package.json')?.toString('utf8')).toBe('{"name":"x"}');
    expect(contents.has('package/dist/index.js')).toBe(false);
  });

  it('names an entry by its pax path record, not its truncated ustar name (regression, S1-12)', () => {
    const real = `package/dist/web/.next-embedded/server/app/${'nested/'.repeat(20)}page.js`;
    const archive = Buffer.concat([
      tarEntry('PaxHeader/page.js', paxRecord('path', real) + paxRecord('mtime', '0'), 'x'),
      tarEntry(real.slice(0, 100), 'export default "@agent-workspace/web";'),
      tarEntry('pax_global_header', paxRecord('comment', 'ignored'), 'g'),
      tarEntry('package/package.json', '{}'),
      Buffer.alloc(1024),
    ]);
    const { names, contents } = readTar(archive, (name) => name.startsWith('package/dist/'));
    expect(names).toEqual([real, 'package/package.json']);
    expect(checkDistContents(contents)).toEqual([
      `${real} names @agent-workspace/*, a scope a third party owns on npm`,
    ]);
  });

  it('names an entry by its GNU long name, and only the entry that follows it', () => {
    const real = `package/dist/web/${'very-long-directory-name/'.repeat(6)}chunk.js`;
    const archive = Buffer.concat([
      tarEntry('././@LongLink', `${real}\0`, 'L'),
      tarEntry(real.slice(0, 100), 'x'),
      tarEntry('package/dist/bin.js', '#!/usr/bin/env node\n'),
      Buffer.alloc(1024),
    ]);
    expect(readTar(archive, () => false).names).toEqual([real, 'package/dist/bin.js']);
  });

  it('refuses a malformed pax record rather than misnaming the next entry', () => {
    const archive = Buffer.concat([
      tarEntry('PaxHeader/x', '99 path=package/dist/x.js\n', 'x'),
      tarEntry('package/dist/x.js', 'x'),
    ]);
    expect(() => readTar(archive, () => true)).toThrow(/malformed record/u);
  });

  it('names link, directory and contiguous entries, and refuses every one that is not a regular file (regression, S1-12)', () => {
    const archive = Buffer.concat([
      tarEntry('package/src/secret.ts', 'x', '7'),
      tarEntry('package/.env', '', '2'),
      tarEntry('package/x', '', '1'),
      tarEntry('package/dist/', '', '5'),
      Buffer.alloc(1024),
    ]);
    const { names, contents, special } = readTar(archive, () => true);
    expect(names).toEqual(['package/src/secret.ts', 'package/.env', 'package/x', 'package/dist/']);
    expect(special).toEqual(['package/.env', 'package/x', 'package/dist/']);
    expect(contents.get('package/src/secret.ts')?.toString('utf8')).toBe('x');
  });
});

describe('verifying a whole tarball', () => {
  it('verifies a whole tarball: a link entry and an unshipped file fail it (regression, S1-12)', () => {
    const fields = packed();
    const manifest = JSON.stringify(fields);
    const good = [
      tarEntry('package/package.json', manifest),
      tarEntry('package/README.md', '#'),
      tarEntry('package/LICENSE', 'L'),
      tarEntry('package/CHANGELOG.md', '#'),
      tarEntry('package/dist/index.js', 'export {};'),
    ];
    const end = Buffer.alloc(1024);
    expect(verifyTarball(gzipSync(Buffer.concat([...good, end])), '0.1.0')).toEqual({
      manifest: fields,
      failures: [],
    });
    const bad = verifyTarball(
      gzipSync(
        Buffer.concat([
          ...good,
          tarEntry('package/dist/.env', '', '2'),
          tarEntry('package/src/secret.ts', 'x', '7'),
          end,
        ]),
      ),
      '0.1.0',
    );
    expect(bad.failures).toEqual([
      'package/dist/.env: only regular files ship, not a link or a directory',
      'src/secret.ts: only dist/, the manifests and nothing else ship',
    ]);
    expect(verifyTarball(gzipSync(Buffer.concat([...good, end])), '0.2.0').failures).toEqual([
      '@indx-workspace/sdk is 0.1.0, not the contracts version 0.2.0',
      '@indx-workspace/sdk dependencies.@indx-workspace/contracts is 0.1.0, not lock-step 0.2.0',
    ]);
  });
});
