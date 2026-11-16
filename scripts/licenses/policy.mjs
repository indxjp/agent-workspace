/** @satisfies {import('./types.mjs').LicensePolicy} */
export const POLICY = {
  // Evaluated as an SPDX expression, so `(BSD-3-Clause OR GPL-2.0)` passes on the BSD disjunct:
  // OR is the licensee's choice and we take BSD-3-Clause.
  allow: [
    'MIT',
    'MIT-0',
    'ISC',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'BlueOak-1.0.0',
    'Python-2.0',
    'PostgreSQL',
  ],

  allowDev: ['MPL-2.0', 'CC-BY-3.0', 'CC-BY-4.0'],

  review: [
    'MPL-2.0',
    'EPL-2.0',
    'CDDL-1.0',
    'CC-BY-4.0',
    'CC-BY-3.0',
    'LGPL-2.1-or-later',
    'LGPL-3.0-or-later',
    'Apache-2.0 AND LGPL-3.0-or-later',
    // Probed 2026-09-03, and not in R-16: `@img/sharp-wasm32@0.35.4` declares a three-way
    // conjunction. Same libvips, plus the MIT-licensed Emscripten runtime.
    'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
  ],

  denyFamilies: [
    'GPL-2.0-only',
    'GPL-2.0-or-later',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'AGPL-3.0-only',
    'AGPL-3.0-or-later',
  ],

  denyLiteral: [
    'SSPL-1.0',
    'BUSL-1.1',
    'Elastic-2.0',
    'CC-BY-NC-4.0',
    'CC-BY-SA-4.0',
    'UNLICENSED',
  ],

  denyByName: [
    'e2b',
    '@e2b/code-interpreter',
    '@daytonaio/sdk',
    'modal',
    '@vercel/sandbox',
    '@cloudflare/sandbox',
  ],
};

/** @type {import('./types.mjs').ExceptionRegistry} */
export const EXCEPTIONS = {
  '@img/sharp-libvips-*': {
    licence: 'LGPL-3.0-or-later',
    scope: 'all',
    reviewer: 'Owner (D-01); dev scope approved by the Owner on 2026-10-31 for #2069',
    reason:
      'Prebuilt libvips, loaded dynamically and unmodified by sharp, itself an optional dependency of Next.js. Weak copyleft; no obligation on our source. NOTICE must state the licence and offer the upstream tarball. Dev: the same unmodified binary reaches the dev tree through next, a devDependency of @indx-workspace/app used only by its J3 desk fixture; nothing is distributed from it.',
    expires: '2026-12-02',
  },
  '@img/sharp-win32-*': {
    licence: 'Apache-2.0 AND LGPL-3.0-or-later',
    scope: 'prod',
    reviewer: 'Owner (D-01)',
    reason:
      'The same libvips, bundled into the platform package rather than split out, on all three win32 architectures. Never present in a published Linux image.',
    expires: '2026-12-02',
  },
  '@img/sharp-wasm32': {
    licence: 'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
    scope: 'prod',
    reviewer: 'Owner (D-01)',
    reason:
      'The same libvips again, compiled to wasm, plus the MIT Emscripten runtime. Resolved only where no native binding exists. Probed 2026-09-03; not recorded in R-16.',
    expires: '2026-12-02',
  },
  'caniuse-lite': {
    licence: 'CC-BY-4.0',
    scope: 'prod',
    reviewer: 'Owner (D-01)',
    reason:
      'Browser-support data shipped inside Next.js. Attribution-only; satisfied by the NOTICE file.',
    expires: '2026-12-02',
  },
  '@anthropic-ai/claude-agent-sdk': {
    licence: 'Unknown',
    actual: 'PROPRIETARY — © Anthropic PBC, all rights reserved ("SEE LICENSE IN README.md")',
    scope: 'prod',
    reviewer: 'Owner (D-13)',
    reason:
      'The product exists to run this SDK (spec §28). Not open source. Redistribution inside our published images is governed by https://code.claude.com/docs/en/legal-and-compliance and is subject to D-13. Must be installed unmodified from npm at image build time, never vendored or patched.',
    expires: '2026-12-02',
  },
  '@anthropic-ai/claude-agent-sdk-*': {
    licence: 'Unknown',
    actual: 'PROPRIETARY — © Anthropic PBC, all rights reserved',
    scope: 'prod',
    reviewer: 'Owner (D-13)',
    reason:
      'Per-platform compiled `claude` binary resolved by the SDK through eight optionalDependencies. Same terms as above.',
    expires: '2026-12-02',
  },
};

export const SPDX_3_28_0_IDENTIFIERS_USED_BY_THIS_POLICY = [
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'PostgreSQL',
  'MPL-2.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'EPL-2.0',
  'CDDL-1.0',
  'LGPL-2.1-or-later',
  'LGPL-3.0-or-later',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'SSPL-1.0',
  'BUSL-1.1',
  'Elastic-2.0',
  'CC-BY-NC-4.0',
  'CC-BY-SA-4.0',
];

// Every identifier the policy mentions, flattened. `UNLICENSED` is excluded by name because it
// is the one string here that is deliberately not an SPDX identifier.
