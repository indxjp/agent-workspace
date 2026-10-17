/* global console */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { engineImages } from '../engine-images.mjs';

const execFileAsync = promisify(execFile);

/**
 * Every image a release publishes, by repository name. ENG-07
 * (docs/adr/0073-one-runtime-image-per-engine.md): one `runtime-<engine>` image per engine whose
 * adapter package exists, next to the three control-plane images, the egress proxy (docs/adr/0117) and the tool host (docs/adr/0118).
 *
 * @param {string} root
 */
export function releaseImages(root) {
  return [
    'web',
    'gateway',
    'runner',
    'egress-proxy',
    'tool-host',
    ...engineImages(root).map((engine) => engine.image),
  ];
}
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** @param {string} file */
async function readJson(file) {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`RELEASE_SOURCE_UNREADABLE: ${file}: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`RELEASE_JSON_INVALID: ${file}: ${String(error)}`, { cause: error });
  }
}

/** @param {string} directory */
async function packageManifests(directory) {
  /** @type {string[]} */
  const manifests = [];
  /** @param {string} current */
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
      throw new Error(`RELEASE_SOURCE_UNREADABLE: ${current}: ${String(error)}`, {
        cause: error,
      });
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === 'package.json') manifests.push(target);
    }
  }
  await visit(directory);
  return manifests;
}

/** @param {string} root */
async function gitTags(root) {
  const { stdout } = await execFileAsync('git', ['-C', root, 'tag', '--list', 'v*']);
  return stdout.trim().split(/\r?\n/u).filter(Boolean);
}

const MAJOR_MINOR = /^(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const CONTRACTS_VERSION_DECLARATION = /^export const CONTRACTS_VERSION = '([^']+)';$/mu;

/**
 * The platform images a generated project pins must serve the contracts minor its own CLI, SDK and
 * `aw` state (ADR-0078 D2). Images and packages are versioned separately, but a project created by
 * `@indx-workspace/create@X.Y.*` runs the images `packages/cli/src/release-images.json` names, and
 * an edge that serves an older minor refuses every request the project's own clients make. So the
 * pinned image version and `CONTRACTS_VERSION` must share their major.minor.
 *
 * @param {string} root
 * @returns {Promise<{ imageVersion: string, contractsVersion: string }>}
 */
export async function checkImagesServeContracts(root) {
  const absoluteRoot = path.resolve(root);
  const imagesPath = path.join(absoluteRoot, 'packages', 'cli', 'src', 'release-images.json');
  const imageVersion = (await readJson(imagesPath)).version;
  const versionPath = path.join(absoluteRoot, 'packages', 'contracts', 'src', 'version.ts');
  const source = await readFile(versionPath, 'utf8').catch((error) => {
    throw new Error(`RELEASE_SOURCE_UNREADABLE: ${versionPath}: ${String(error)}`, {
      cause: error,
    });
  });
  const contractsVersion = CONTRACTS_VERSION_DECLARATION.exec(source)?.[1];
  const images = typeof imageVersion === 'string' ? MAJOR_MINOR.exec(imageVersion) : null;
  const contracts = contractsVersion === undefined ? null : MAJOR_MINOR.exec(contractsVersion);
  if (images === null || contracts === null) {
    throw new Error(
      `RELEASE_VERSION_INVALID: images=${JSON.stringify(imageVersion)} contracts=${JSON.stringify(contractsVersion)}`,
    );
  }
  if (images[1] !== contracts[1] || images[2] !== contracts[2]) {
    throw new Error(
      `IMAGES_CONTRACTS_MINOR_MISMATCH: release-images.json pins ${String(imageVersion)} but CONTRACTS_VERSION is ${String(contractsVersion)}; publish and pin images ${String(contracts[1])}.${String(contracts[2])}.x first (ADR-0078 D2)`,
    );
  }
  return { imageVersion: String(imageVersion), contractsVersion: String(contractsVersion) };
}

/**
 * @param {string} root
 * @param {{tags?: string[]}} [options]
 */
export async function checkReleaseTree(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const rootManifest = await readJson(path.join(absoluteRoot, 'package.json'));
  const version = rootManifest.version;
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw new Error(`RELEASE_VERSION_INVALID: root package version is ${JSON.stringify(version)}`);
  }

  const releaseNotesPath = path.join(absoluteRoot, 'docs', 'release', 'notes', `${version}.md`);
  const releaseNotes = await readFile(releaseNotesPath, 'utf8').catch((error) => {
    throw new Error(`RELEASE_SOURCE_UNREADABLE: ${releaseNotesPath}: ${String(error)}`, {
      cause: error,
    });
  });
  if (!releaseNotes.startsWith(`# Agent Workspace ${version} release notes\n`)) {
    throw new Error(`RELEASE_NOTES_VERSION_MISMATCH: ${releaseNotesPath}`);
  }

  const changelogPath = path.join(absoluteRoot, 'CHANGELOG.md');
  const changelog = await readFile(changelogPath, 'utf8').catch((error) => {
    throw new Error(`RELEASE_SOURCE_UNREADABLE: ${changelogPath}: ${String(error)}`, {
      cause: error,
    });
  });
  const newestVersion = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/mu.exec(changelog)?.[1];
  if (newestVersion !== version) {
    throw new Error(
      `CHANGELOG_VERSION_MISMATCH: newest=${String(newestVersion)} package=${version}`,
    );
  }

  const sdkContract = await readJson(
    path.join(absoluteRoot, 'docs', 'research', 'R-01-options.json'),
  );
  const sdkVersion = sdkContract.version;
  if (typeof sdkVersion !== 'string' || !EXACT_VERSION.test(sdkVersion)) {
    throw new Error(`SDK_CONTRACT_VERSION_INVALID: ${JSON.stringify(sdkVersion)}`);
  }
  const manifests = [
    path.join(absoluteRoot, 'package.json'),
    ...(await packageManifests(path.join(absoluteRoot, 'apps'))),
    ...(await packageManifests(path.join(absoluteRoot, 'packages'))),
  ];
  let sdkDependencyCount = 0;
  for (const manifestPath of manifests) {
    const manifest = await readJson(manifestPath);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const specifier = manifest[field]?.['@anthropic-ai/claude-agent-sdk'];
      if (specifier === undefined) continue;
      sdkDependencyCount += 1;
      if (specifier !== sdkVersion) {
        throw new Error(
          `SDK_SPECIFIER_NOT_EXACT: ${manifestPath} has ${JSON.stringify(specifier)}; expected ${sdkVersion}`,
        );
      }
    }
  }
  if (sdkDependencyCount === 0) {
    throw new Error('SDK_DEPENDENCY_MISSING: no manifest declares @anthropic-ai/claude-agent-sdk');
  }

  const tags = options.tags ?? (await gitTags(absoluteRoot));
  const expectedTag = `v${version}`;
  let tagStatus = 'unreleased';
  if (tags.length > 0) {
    if (!tags.includes(expectedTag)) {
      throw new Error(`RELEASE_TAG_MISMATCH: expected ${expectedTag}; found ${tags.join(', ')}`);
    }
    const { stdout } = await execFileAsync('git', [
      '-C',
      absoluteRoot,
      'show',
      `${expectedTag}:package.json`,
    ]);
    const taggedVersion = JSON.parse(stdout).version;
    if (taggedVersion !== version) {
      throw new Error(
        `RELEASE_TAG_CONTENT_MISMATCH: ${expectedTag} contains ${String(taggedVersion)}`,
      );
    }
    tagStatus = 'tagged';
  }

  return {
    version,
    tagStatus,
    sdkVersion,
    sdkDependencyCount,
    images: releaseImages(absoluteRoot),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const pinned = await checkImagesServeContracts(process.cwd());
    console.log(
      `images serve contracts: images=${pinned.imageVersion} contracts=${pinned.contractsVersion}`,
    );
    const result = await checkReleaseTree(process.cwd());
    console.log(
      `release check passed: version=${result.version} tag=${result.tagStatus} sdk=${result.sdkVersion} declarations=${String(result.sdkDependencyCount)} images=${result.images.join(',')}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
