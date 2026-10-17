#!/usr/bin/env node
/**
 * Generates the repository's `llms.txt` — the reading index for coding agents and language
 * models (https://llmstxt.org) — from two sources that already exist: a short curated list of
 * repository documents (below; each entry's title is read from the document's own `# ` heading,
 * so a renamed document is drift, not a stale line) and the docs site's navigation
 * (`docs/sdk/site/docs.json`, with each page's `title` and `description` read from its
 * frontmatter). `--write` rewrites `llms.txt`; `--check` renders it in memory and fails when the
 * committed file differs — the same rule ADR-0054 applies to the reference pages.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUTPUT = 'llms.txt';
const SITE_DIR = 'docs/sdk/site';

/**
 * The repository documents worth reading before the docs site, in reading order. The description
 * is written here because these documents have no frontmatter; the title is not, because the
 * document already states it.
 * @type {readonly { readonly heading: string, readonly documents: readonly { readonly path: string, readonly description: string }[] }[]}
 */
const REPOSITORY_SECTIONS = [
  {
    heading: 'Start here',
    documents: [
      {
        path: 'AGENTS.md',
        description:
          'The operational checklist for coding agents: the working agreement, the required verification, the pull-request rules.',
      },
      {
        path: 'CLAUDE.md',
        description:
          'Instructions for Claude Code in this repository: what to read first and the per-task procedure.',
      },
      {
        path: 'ENGINEERING_GUIDELINES.md',
        description:
          'The rules for production code, tests and agent changes; a repository-wide gate is weakened only by an ADR.',
      },
      {
        path: 'docs/architecture.md',
        description:
          'System shape, what each application and package owns and must not own, the dependency direction and the trust boundaries — enforced by dependency-cruiser.',
      },
      {
        path: 'docs/sdk/site/README.md',
        description:
          'How the docs site is previewed, checked and generated, and the Today / Target callout convention every page follows.',
      },
    ],
  },
  {
    heading: 'Product and design',
    documents: [
      {
        path: 'docs/spec.md',
        description:
          'The original specification: a minimal, self-hosted enterprise control plane around the Claude Agent SDK.',
      },
      {
        path: 'docs/sdk/README.md',
        description:
          'The SDK programme: the two meanings of "SDK" in this repository, the staged approach, and the four design documents.',
      },
      {
        path: 'docs/sdk/02-use-cases-and-documentation.md',
        description:
          'The consumer use cases the SDK is designed for and the documentation they need.',
      },
      {
        path: 'docs/sdk/03-sdk-design.md',
        description:
          'Package structure and layering, the public API and usage patterns, versioning, the testing seam and the application-migration plan.',
      },
      {
        path: 'docs/sdk/04-api-specification.md',
        description:
          'The normative resource-by-resource contract of /api/**, the role table, runtime neutrality (§6) and the server changes still required (§8).',
      },
      {
        path: 'docs/sdk/07-structure-map.md',
        description:
          'One page to read before touching a migration unit: the package map with the allowed import direction, one resource through the four layers, the ER diagram of the tables the SDK surfaces, and the resource-to-route-to-SDK-to-CLI table.',
      },
      {
        path: 'docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md',
        description:
          'The refactoring programme: the target architecture of the platform and the RF-nnn units that reach it.',
      },
      {
        path: 'docs/architecture/refactoring/claude-agent-workspace-refactoring-decisions.md',
        description: 'The decision ledger of the refactoring programme.',
      },
      {
        path: 'docs/adr/README.md',
        description:
          'The architecture decision log for the whole programme, with its generated index of every record.',
      },
      {
        path: 'docs/adr/0052-the-sdk-is-contracts-first-and-the-application-is-its-first-consumer.md',
        description:
          'Why the SDK is two packages with one dependency direction, why the application is its first consumer, and why the packages are not published yet.',
      },
      {
        path: 'docs/adr/0054-developer-documentation-is-a-mintlify-site-generated-from-the-contracts.md',
        description:
          'Why the developer documentation is a Mintlify site whose reference pages are generated from the contracts, the SDK and the CLI, with staleness as a CI failure.',
      },
    ],
  },
  {
    heading: 'Operating the platform and its status',
    documents: [
      {
        path: 'docs/capability-status.md',
        description:
          'Generated: the release verdict per capability and the evidence each one still needs.',
      },
      {
        path: 'docs/runtime-driver-matrix.md',
        description:
          'Generated: which runtime driver is verified for which capability in this build.',
      },
      {
        path: 'docs/deploy/single-vm.md',
        description: 'Docker Compose on one VM: the security boundary and the start procedure.',
      },
      {
        path: 'docs/deploy/kubernetes.md',
        description: 'The Helm chart and its per-cloud values files.',
      },
      {
        path: 'docs/deploy/azure-container-apps.md',
        description: 'The managed-sandbox preview deployment on the same images.',
      },
      {
        path: 'docs/operations/runbook.md',
        description: 'Production operations: upgrade, backup and restore, drills.',
      },
      {
        path: 'docs/upgrade-policy.md',
        description:
          'How the Claude Agent SDK dependency is upgraded and what compatibility is promised.',
      },
      {
        path: 'docs/dependency-policy.md',
        description: 'Which dependencies and licences are allowed.',
      },
    ],
  },
];

/** The docs-site tab whose pages go under llms.txt's `Optional` section: generated reference. */
const OPTIONAL_TAB = 'Reference';

/** @param {string} repoRoot @param {string} relativePath */
function abs(repoRoot, relativePath) {
  return path.join(repoRoot, ...relativePath.split('/'));
}

/** @param {string} repoRoot @param {string} relativePath */
async function readRepositoryFile(repoRoot, relativePath) {
  try {
    return await readFile(abs(repoRoot, relativePath), 'utf8');
  } catch {
    throw new Error(`llms.txt lists ${relativePath}, which does not exist`);
  }
}

/**
 * The document's own `# ` heading, which is what a reader will see when they open it.
 * @param {string} markdown @param {string} relativePath
 */
function firstHeading(markdown, relativePath) {
  const match = /^# (.+)$/mu.exec(markdown);
  if (match?.[1] === undefined) {
    throw new Error(`${relativePath} has no "# " heading to use as its title`);
  }
  return match[1].trim();
}

/**
 * The `title` and `description` of a page's frontmatter — two double-quoted scalars, which is the
 * only shape this site writes (`scripts/docs/lib/mdx.mjs` and the hand-written pages alike).
 * @param {string} source @param {string} relativePath
 */
function frontmatter(source, relativePath) {
  const block = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  if (block?.[1] === undefined) throw new Error(`${relativePath} has no frontmatter`);
  /** @type {Map<string, string>} */
  const fields = new Map();
  for (const line of block[1].split('\n')) {
    const field = /^(\w+): "(.*)"$/u.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined)
      fields.set(field[1], field[2].replace(/\\"/gu, '"'));
  }
  const title = fields.get('title');
  const description = fields.get('description');
  if (title === undefined || description === undefined) {
    throw new Error(`${relativePath} frontmatter needs a quoted title and description`);
  }
  return { title, description };
}

/**
 * A group lists `pages`, or names an `openapi` document from which Mintlify renders one page per
 * operation (the Reference tab's HTTP API group, issue #245).
 * @param {string} repoRoot
 * @returns {Promise<readonly { readonly tab: string, readonly group: string, readonly pages: readonly string[], readonly openapi: string | undefined }[]>}
 */
async function siteNavigation(repoRoot) {
  const manifestPath = `${SITE_DIR}/docs.json`;
  /** @type {{ readonly navigation: { readonly tabs: readonly { readonly tab: string, readonly groups: readonly { readonly group: string, readonly pages?: readonly string[], readonly openapi?: string }[] }[] } }} */
  const manifest = JSON.parse(await readRepositoryFile(repoRoot, manifestPath));
  return manifest.navigation.tabs.flatMap((tab) =>
    tab.groups.map((group) => ({
      tab: tab.tab,
      group: group.group,
      pages: group.pages ?? [],
      openapi: group.openapi,
    })),
  );
}

/**
 * The llms.txt line for a group's OpenAPI document, which has no frontmatter to read.
 * @param {string} repoRoot @param {string} document
 */
async function openApiEntry(repoRoot, document) {
  const relativePath = `${SITE_DIR}/${document}`;
  /** @type {{ readonly info: { readonly title: string } }} */
  const parsed = JSON.parse(await readRepositoryFile(repoRoot, relativePath));
  return entry(
    `${parsed.info.title} (OpenAPI 3.1)`,
    relativePath,
    'Every public /api/** route as one OpenAPI 3.1 document, generated from the contracts; generate a client in any language from it.',
  );
}

/**
 * One `- [title](path): description` line.
 * @param {string} title @param {string} relativePath @param {string} description
 */
function entry(title, relativePath, description) {
  return `- [${title}](${relativePath}): ${description}`;
}

/** @param {string} repoRoot */
async function renderRepositorySections(repoRoot) {
  const sections = [];
  for (const section of REPOSITORY_SECTIONS) {
    const lines = [];
    for (const document of section.documents) {
      const markdown = await readRepositoryFile(repoRoot, document.path);
      lines.push(entry(firstHeading(markdown, document.path), document.path, document.description));
    }
    sections.push(`## ${section.heading}\n\n${lines.join('\n')}`);
  }
  return sections;
}

/** @param {string} repoRoot */
async function renderSiteSections(repoRoot) {
  const sections = [];
  const optional = [];
  for (const { tab, group, pages, openapi } of await siteNavigation(repoRoot)) {
    const lines = openapi === undefined ? [] : [await openApiEntry(repoRoot, openapi)];
    for (const page of pages) {
      const relativePath = `${SITE_DIR}/${page}.mdx`;
      const { title, description } = frontmatter(
        await readRepositoryFile(repoRoot, relativePath),
        relativePath,
      );
      lines.push(entry(title, relativePath, description));
    }
    if (tab === OPTIONAL_TAB) optional.push(...lines);
    else sections.push(`## Docs site: ${group}\n\n${lines.join('\n')}`);
  }
  if (optional.length > 0) sections.push(`## Optional\n\n${optional.join('\n')}`);
  return sections;
}

/**
 * Render `llms.txt` from the repository at `repoRoot`. Deterministic: no timestamps, and the order
 * is the order of the curated list and of the site's navigation.
 * @param {string} repoRoot
 * @returns {Promise<string>}
 */
export async function renderLlmsTxt(repoRoot) {
  const preamble = [
    '# Agent Workspace',
    '',
    '> A self-hosted control plane around the Claude Agent SDK: workspaces, people, agents, skills,',
    '> tool servers, models and sandboxes managed in one place and exposed through one API, so the',
    '> same agents can be driven from its own screens, a backend, a frontend, or a terminal. This',
    '> file is the reading index for coding agents and language models working in this repository.',
    '',
    `Generated by \`pnpm docs:generate\` (\`scripts/docs/generate-llms-txt.mjs\`) from the documents`,
    `it lists and from the docs site's navigation; \`pnpm docs:check\` fails when it is stale.`,
    'Regenerate it, do not edit it. Paths are relative to the repository root. A docs-site page',
    `(\`${SITE_DIR}/<page>.mdx\`) is served at \`/<page>\` when the site runs (\`npx mint dev\` in`,
    `\`${SITE_DIR}\`). The site's reference pages and its OpenAPI document are generated from the`,
    'contracts, the SDK and the CLI source and are listed last, under Optional.',
    '',
    'The order matters: the repository rules first, then what the product is and where it is going,',
    'then the guides, then the resource-by-resource detail.',
  ];
  const sections = [
    ...(await renderRepositorySections(repoRoot)),
    ...(await renderSiteSections(repoRoot)),
  ];
  return `${[preamble.join('\n'), ...sections].join('\n\n')}\n`;
}

/**
 * Compare the rendered text against the committed `llms.txt`, byte for byte.
 * @param {string} rendered @param {string} repoRoot
 * @returns {Promise<{ readonly ok: boolean, readonly issue: string | null }>}
 */
export async function compareWithDisk(rendered, repoRoot) {
  let existing;
  try {
    existing = await readFile(abs(repoRoot, OUTPUT), 'utf8');
  } catch {
    return { ok: false, issue: `missing: ${OUTPUT} — run \`pnpm docs:generate\`` };
  }
  if (existing !== rendered) {
    return { ok: false, issue: `stale: ${OUTPUT} — run \`pnpm docs:generate\`` };
  }
  return { ok: true, issue: null };
}

/** @param {readonly string[]} argv @param {string} repoRoot */
async function main(argv, repoRoot) {
  if (argv.includes('--write')) {
    await writeFile(abs(repoRoot, OUTPUT), await renderLlmsTxt(repoRoot), 'utf8');
    process.stdout.write(`wrote ${OUTPUT}\n`);
    return 0;
  }
  if (argv.includes('--check')) {
    const result = await compareWithDisk(await renderLlmsTxt(repoRoot), repoRoot);
    if (result.ok) {
      process.stdout.write(`${OUTPUT} is current with its sources\n`);
      return 0;
    }
    process.stderr.write(`${result.issue ?? 'stale'}\n`);
    return 1;
  }
  process.stderr.write('usage: generate-llms-txt.mjs --write | --check\n');
  return 2;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
  process.exitCode = await main(process.argv.slice(2), repoRoot);
}
