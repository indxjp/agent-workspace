import path from 'node:path';

import { RESEARCH_FIXTURE_ROOT } from './boundaries.js';

/** Extensions whose contents are scanned as JavaScript/TypeScript module source. */
export const MODULE_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/** Markup that can carry a `<script>`, an `importmap`, or a `src`/`href` naming a module. */
export const MARKUP_EXTENSIONS = new Set(['.html', '.htm']);

/** Structured data cannot import anything but can declare a dependency, which a manifest test reads. */
const STRUCTURED_DATA_EXTENSIONS = new Set(['.json']);

/**
 * Extensions that cannot reference a module under any resolution this repository uses.
 *
 * Markdown is here on purpose and is the reason the gate has this shape: research notes contain
 * fenced code that imports the SDK, and a gate that grepped for the package name would have to
 * exclude `docs/`, and an excluded directory is a directory the gate no longer covers.
 */
const INERT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  // Wrangler configs (infra/cloudflare): JSON with comments, read by wrangler, never a manifest.
  '.jsonc',
  // The Lean specification (formal/, ADR-0062): a Lean `import` names Lean modules only.
  '.lean',
  '.ini',
  '.csv',
  '.sql',
  '.sh',
  '.bash',
  '.ps1',
  '.css',
  '.scss',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  // Office fixtures (tests/gallery): zips of XML parts, opened by a docx or xlsx reader.
  '.docx',
  '.xlsx',
  '.zip',
  '.patch',
  '.diff',
  '.lock',
  // W1-INT-02, each with the positive reason it is inert rather than "no rule matched":
  //   .conf  a daemon configuration (`apps/web/server/runs/acceptance/nginx.conf`); nginx parses
  //          its own directive grammar and has no JavaScript module resolver.
  //   .env   KEY=VALUE lines read by docker compose and `process.env`; a value reaches a
  //          program's environment, never a module specifier.
  '.conf',
  '.env',
  '.hcl',
  '.service',
  '.tf',
  '.tfvars',
  '.tftpl',
  // A Helm named-template partial (infra/helm/*/templates/_helpers.tpl), read by helm only.
  '.tpl',
  '.timer',
  // Use-case gallery fixture data (tests/gallery/) that a tool reads as text: an ASCII CAD
  // drawing and a WebVTT meeting transcript.
  '.dxf',
  '.vtt',
  // A vitest snapshot: recorded output that vitest's snapshot reader parses itself.
  '.snap',
]);

/**
 * Suffixes that mean "a template of the file this name would otherwise be".
 *
 * `.env.example` fell through to `'unclassified'`. Adding `.example` to the inert list would have
 * made `handler.ts.example` inert too, and a committed TypeScript template that imports the SDK
 * is exactly what this gate exists to see. So the suffix is *stripped* and the remainder is
 * classified.
 */
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template'] as const;

/**
 * `Dockerfile` and `<stage>.Dockerfile`. Docker's builder parses its own instruction grammar; the
 * module references in a `RUN node …` line are resolved by a node inside the image, not against
 * this repository's module graph.
 */
function isDockerfile(base: string): boolean {
  return base === 'Dockerfile' || base.endsWith('.Dockerfile');
}

/** Files with no extension, or whose whole name is the extension. */
const INERT_BASENAMES = new Set([
  'LICENSE',
  'LICENCE',
  'NOTICE',
  'CODEOWNERS',
  'Dockerfile',
  // elan's toolchain pin for the Lean specification (formal/lean-toolchain, ADR-0062).
  'lean-toolchain',
  '.gitignore',
  '.gitattributes',
  '.gitkeep',
  '.gitmodules',
  // gitleaks reads fingerprints from it; it is a list of ignored findings, never loaded as code.
  '.gitleaksignore',
  '.npmrc',
  '.nvmrc',
  '.dockerignore',
  '.gcloudignore',
  '.prettierignore',
  '.eslintignore',
  '.editorconfig',
  // `path.extname('.env')` is the empty string (a leading dot is the whole name), so a dotfile
  // has to be named here even when its "extension" is listed above. `.env.example` reaches this
  // table through TEMPLATE_SUFFIXES.
  '.env',
  // `env` and `gitignore` are rendered dotfiles that gave up their leading dot to stay committed
  // (`.gitignore` excludes `.env`), e.g. the goldens under `packages/cli/src/fixtures/<cloud>/`.
  // Their contents are the KEY=VALUE lines and path patterns the dotted names carry.
  'env',
  'gitignore',
]);

export type FileClass = 'module-source' | 'markup' | 'structured-data' | 'inert' | 'unclassified';

/**
 * The basename with every template suffix stripped, repeatedly, so `x.ts.example.template`
 * classifies as the `.ts` it is a template of. A name that is *only* a suffix (`.example`) is left
 * alone: stripping it would leave nothing to classify, and the fall-through must decide it.
 */
function classifiedBasename(file: string): string {
  let base = path.basename(file);
  for (;;) {
    const suffix = TEMPLATE_SUFFIXES.find((s) => base.toLowerCase().endsWith(s) && base !== s);
    if (suffix === undefined) break;
    base = base.slice(0, -suffix.length);
  }
  return base;
}

/**
 * Which kind a tracked file is, and `'unclassified'` for anything else.
 *
 * ADR-0015's rule applied to the *inputs* of the scan: an earlier version filtered the tree to a
 * set of source extensions and silently ignored the rest, so a module in a file kind nobody had
 * thought about would have been invisible to the gate that forbids it. No branch here lets a file
 * through; the test on the unclassified set is that it is empty.
 */
export function classifyFile(file: string): FileClass {
  const base = classifiedBasename(file);
  if (INERT_BASENAMES.has(base) || isDockerfile(base)) return 'inert';
  const ext = path.extname(base).toLowerCase();
  if (MODULE_SOURCE_EXTENSIONS.has(ext)) return 'module-source';
  if (MARKUP_EXTENSIONS.has(ext)) return 'markup';
  if (STRUCTURED_DATA_EXTENSIONS.has(ext)) return 'structured-data';
  if (INERT_EXTENSIONS.has(ext)) return 'inert';
  return 'unclassified';
}

export function isPackageManifest(file: string): boolean {
  return classifiedBasename(file) === 'package.json';
}

/**
 * The extension a research probe is written in.
 *
 * `docs/research/fixtures/agent-sdk/README.md` tells a reader to copy a probe out of the
 * repository and run it under `node` in a scratch directory with the SDK installed. `.mjs` is the
 * only extension for which that holds unconditionally: a `.js` is ESM here only because the
 * repository root manifest says `"type": "module"`, and a `.ts` probe belongs to no `tsconfig`, so
 * no typecheck or lint would read a file this gate permits to import the SDK. The permit is for
 * evidence a reader can run, so the shape is the shape that runs. Adding an extension is the fix
 * when a probe legitimately needs one, with the reason beside it.
 */
export const PROBE_EXTENSIONS = new Set(['.mjs']);

/**
 * What a tracked file under {@link RESEARCH_FIXTURE_ROOT} is.
 *
 *   * `probe`: executable evidence, **permitted to import the SDK**.
 *   * `capture`: a recorded artefact or the prose around it, which cannot name a module and so
 *     needs no permit. Derived from {@link classifyFile} so the two cannot drift. `markup` is
 *     deliberately not a capture: an HTML fixture names modules through `src`/`href`, so someone
 *     has to decide whether it is evidence or a page.
 *
 * There is no third answer and no default (ADR-0027 clause 2): anything else is `unrecognised`,
 * carries the reason, and the test on that set is that it is empty.
 */
export type FixtureVerdict =
  | { readonly kind: 'probe' | 'capture' }
  | { readonly kind: 'unrecognised'; readonly reason: string };

export function classifyResearchFixture(file: string): FixtureVerdict {
  const kind = classifyFile(file);
  if (kind === 'module-source') {
    const ext = path.extname(classifiedBasename(file)).toLowerCase();
    if (PROBE_EXTENSIONS.has(ext)) return { kind: 'probe' };
    return {
      kind: 'unrecognised',
      reason:
        `module source under ${RESEARCH_FIXTURE_ROOT}/ whose extension is not one this gate ` +
        `recognises as a runnable probe (${[...PROBE_EXTENSIONS].join(', ')}). A probe is ` +
        `evidence a reader re-runs with node; rename it, or add its extension to ` +
        `PROBE_EXTENSIONS with the reason it runs.`,
    };
  }
  if (kind === 'inert' || kind === 'structured-data') return { kind: 'capture' };
  return {
    kind: 'unrecognised',
    reason:
      `classified '${kind}': a file under ${RESEARCH_FIXTURE_ROOT}/ is either a runnable probe ` +
      `or an inert capture, and this is neither, so no one has decided whether the §42 permit ` +
      `covers it.`,
  };
}
