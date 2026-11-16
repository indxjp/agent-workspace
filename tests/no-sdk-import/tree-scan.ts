import path from 'node:path';

import { isResearchFixture, REPO_ROOT, SDK_BOUNDARY_FILES } from './boundaries.js';
import {
  markupReferences,
  markupTargetIsFixture,
  markupTargetIsSdk,
  resolveMarkupReference,
} from './markup.js';
import { insideResearchFixtures, sdkOwns } from './packages.js';
import { resolveSpecifier } from './resolve.js';
import { scanModuleSource, type ModuleReference, type Undecidable } from './scan.js';
import { classified, readTracked, researchProbes, scanned } from './tracked.js';
import { decideUnresolvedReference, researchFixtureReadme } from './unresolved.js';

/** What scanning the whole tracked tree found. The sets are sorted so a failure diff is stable. */
export type TreeScan = {
  /** Every reference this gate cannot decide, as a refusal naming the file. */
  readonly undecidable: Undecidable[];
  /** Files that reach a confined SDK. */
  readonly importers: string[];
  /** Files outside the fixture tree that resolve to a module inside it. */
  readonly fixtureConsumers: string[];
  /** The ADR-0032 clause 1 classification, so it can be asserted rather than skipped. */
  readonly undeclaredFixturePackages: string[];
  /** Which file, which specifier, and the README that documents the package. */
  readonly undeclaredFixtureEdges: string[];
  /**
   * Why each detected file was detected, as `file: specifier -> resolved path`. ADR-0030's
   * consequence list asks for it: once the answer is a resolution, the interesting thing in a
   * failure is the *mapping*, since a specifier and the file it names need not look alike.
   */
  readonly detectedEdges: string[];
};

type FileReach = { sdk: boolean; fixtures: boolean };

type Findings = {
  readonly undecidable: Undecidable[];
  readonly undeclaredPackages: Set<string>;
  readonly undeclaredEdges: string[];
  readonly detectedEdges: string[];
};

function edgeLine(file: string, specifier: string, target: string): string {
  return `${file}: ${JSON.stringify(specifier)} -> ${path.relative(REPO_ROOT, target) || target}`;
}

function scanMarkupFile(file: string, source: string, findings: Findings): FileReach {
  const reach: FileReach = { sdk: false, fixtures: false };
  const absolute = path.join(REPO_ROOT, file);
  const found = markupReferences(file, source);
  findings.undecidable.push(...found.undecidable);
  for (const reference of found.references) {
    const target = resolveMarkupReference(absolute, reference);
    if (target.kind === 'unreadable') {
      findings.undecidable.push({ file, reason: target.reason });
      continue;
    }
    const where = target.kind === 'file' ? target.path : target.href;
    if (markupTargetIsSdk(target)) {
      reach.sdk = true;
      findings.detectedEdges.push(edgeLine(file, reference, where));
    }
    if (markupTargetIsFixture(target)) {
      reach.fixtures = true;
      findings.detectedEdges.push(edgeLine(file, reference, where));
    }
  }
  return reach;
}

/**
 * Two verdicts and no third path (ADR-0032). Everything that is not the classification is still
 * the ADR-0031 refusal, with the reason saying which of the three conditions failed.
 */
function recordUnresolved(file: string, reference: ModuleReference, findings: Findings): void {
  const verdict = decideUnresolvedReference(file, reference, researchFixtureReadme);
  if (verdict.kind === 'refused') {
    findings.undecidable.push({ file, reason: verdict.reason });
    return;
  }
  findings.undeclaredPackages.add(verdict.packageName);
  findings.undeclaredEdges.push(
    `${file}: ${JSON.stringify(reference.specifier)} -> ${verdict.packageName}, documented in ${verdict.readme}`,
  );
}

function scanModuleFile(file: string, source: string, findings: Findings): FileReach {
  const reach: FileReach = { sdk: false, fixtures: false };
  const absolute = path.join(REPO_ROOT, file);
  const found = scanModuleSource(file, source);
  findings.undecidable.push(...found.undecidable);
  for (const reference of found.references) {
    const resolution = resolveSpecifier(absolute, reference.specifier);
    if (resolution.kind === 'unresolved') {
      recordUnresolved(file, reference, findings);
      continue;
    }
    if (resolution.kind === 'builtin') continue;
    const edge = edgeLine(file, reference.specifier, resolution.file);
    if (sdkOwns(resolution.file)) {
      reach.sdk = true;
      findings.detectedEdges.push(edge);
    }
    if (insideResearchFixtures(resolution.file)) {
      reach.fixtures = true;
      findings.detectedEdges.push(edge);
    }
  }
  return reach;
}

const byName = (a: string, b: string): number => a.localeCompare(b);

function scanTrackedTree(): TreeScan {
  const findings: Findings = {
    undecidable: [],
    undeclaredPackages: new Set(),
    undeclaredEdges: [],
    detectedEdges: [],
  };
  const importers: string[] = [];
  const fixtureConsumers: string[] = [];
  for (const file of scanned) {
    const source = readTracked(file);
    const reach =
      classified.get(file) === 'markup'
        ? scanMarkupFile(file, source, findings)
        : scanModuleFile(file, source, findings);
    if (reach.sdk) importers.push(file);
    // The fixture tree is left out of this one on purpose (declared in the ADR): a probe naming a
    // sibling probe is evidence citing evidence, and it is the *outward* direction, product code
    // naming a probe, that turns a permit into a dependency.
    if (!isResearchFixture(file) && reach.fixtures) fixtureConsumers.push(file);
  }
  return {
    undecidable: findings.undecidable.sort((a, b) =>
      `${a.file}: ${a.reason}`.localeCompare(`${b.file}: ${b.reason}`),
    ),
    importers: importers.sort(byName),
    fixtureConsumers: fixtureConsumers.sort(byName),
    undeclaredFixturePackages: [...findings.undeclaredPackages].sort(byName),
    undeclaredFixtureEdges: findings.undeclaredEdges.sort(byName),
    detectedEdges: findings.detectedEdges.sort(byName),
  };
}

export const treeScan = scanTrackedTree();

/** The whole permitted set, printed on failure because it can no longer be read off a literal. */
export const PERMITTED = [...SDK_BOUNDARY_FILES, ...researchProbes].sort(byName);
