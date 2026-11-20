export const MANIFESTS = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/CHANGELOG.md',
];

export function packed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@indx-workspace/sdk',
    version: '0.1.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/indxjp/agent-workspace.git',
      directory: 'packages/sdk',
    },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './testing': { types: './dist/testing.d.ts', default: './dist/testing.js' },
    },
    dependencies: { '@indx-workspace/contracts': '0.1.0', zod: '4.6.5' },
    ...overrides,
  };
}

/** One ustar header and body, the shape `npm pack` writes. */
export function tarEntry(name: string, body: string, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write(type, 156, 'utf8');
  const padded = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  padded.write(body, 0, 'utf8');
  return Buffer.concat([header, padded]);
}

/** One pax extended-header record: its length counts every byte of the record, itself included. */
export function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(rest) + 1;
  while (String(length).length + Buffer.byteLength(rest) !== length) length += 1;
  return `${String(length)}${rest}`;
}

/** The embedded package's packed manifest, as its build stages it (ADR-0109). */
export function packedEmbedded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@indx-workspace/embedded',
    version: '0.1.0',
    description: 'The Agent Workspace local runtime.',
    license: 'Apache-2.0',
    homepage: 'https://github.com/indxjp/agent-workspace/tree/main/packages/embedded#readme',
    repository: {
      type: 'git',
      url: 'git+https://github.com/indxjp/agent-workspace.git',
      directory: 'packages/embedded',
    },
    bugs: { url: 'https://github.com/indxjp/agent-workspace/issues' },
    engines: { node: '>=24' },
    type: 'module',
    exports: { './launch': './dist/bin.js', './package.json': './package.json' },
    bin: { 'agent-workspace-embedded': './dist/bin.js' },
    dependencies: { 'embedded-postgres': '18.1.0-beta.16', next: '16.0.10', zod: '4.6.5' },
    publishConfig: { access: 'public' },
    ...overrides,
  };
}
