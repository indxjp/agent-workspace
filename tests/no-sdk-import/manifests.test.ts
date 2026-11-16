import { describe, expect, it } from 'vitest';

import { ENGINE_SDK_BOUNDARIES, RUNTIME_BUNDLE_MANIFEST, SDK_PACKAGES } from './boundaries.js';
import { asRecord } from './packages.js';
import { exampleAppOf } from './resolve.js';
import { treeScan } from './tree-scan.js';
import { classified, packageManifests, readTracked, tracked } from './tracked.js';

const { importers } = treeScan;

/** The four fields a package manager installs a dependency from (ADR-0028 carries the reason the rest are left out). */
const DEPENDENCY_BLOCKS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const NON_RUNTIME_BLOCKS = ['devDependencies', 'peerDependencies', 'optionalDependencies'];

function readManifest(manifest: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readTracked(manifest)) as unknown;
  } catch (error) {
    throw new Error(
      `${manifest} could not be parsed, so its dependencies cannot be read by this gate: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new Error(`${manifest} is not a JSON object, so its dependencies cannot be read.`);
  }
  return record;
}

const byName = (a: string, b: string): number => a.localeCompare(b);

/**
 * `Object.keys` rather than `Object.prototype.hasOwnProperty.call(value, SDK_PACKAGE)`: that call
 * hands a string resolving to the SDK to a callee rooted at `Object`, which the call-site
 * classifier refuses because no binding in the file explains it. The refusal is the classifier
 * working, so the call is written a way the gate can decide.
 */
function declaresConfinedSdk(manifest: Record<string, unknown>): boolean {
  return DEPENDENCY_BLOCKS.some((block) => {
    const names = Object.keys(asRecord(manifest[block]) ?? {});
    return ENGINE_SDK_BOUNDARIES.some((row) => names.includes(row.sdkPackage));
  });
}

/** Asserts no SDK is declared anywhere but `dependencies`, where a pin can be compared. */
function expectNoConfinedSdkOutsideDependencies(
  manifest: Record<string, unknown>,
  label: string,
): void {
  const confined = [...SDK_PACKAGES];
  for (const block of NON_RUNTIME_BLOCKS) {
    const names = Object.keys(asRecord(manifest[block]) ?? {});
    expect(
      names.filter((name) => confined.includes(name)),
      `${label} ${block}`,
    ).toEqual([]);
  }
}

/** Every confined SDK `dependencies` declares at anything but the owning engine's exact pin. */
function pinMismatches(dependencies: Record<string, unknown>, label: string): string[] {
  const mismatched: string[] = [];
  for (const row of ENGINE_SDK_BOUNDARIES) {
    if (!Object.keys(dependencies).includes(row.sdkPackage)) continue;
    const ownerPin = asRecord(readManifest(row.manifest)['dependencies'])?.[row.sdkPackage];
    const pin = dependencies[row.sdkPackage];
    if (typeof ownerPin !== 'string' || pin !== ownerPin) {
      mismatched.push(
        `${label} ${row.sdkPackage}: ${String(pin)} here, ${String(ownerPin)} in ${row.manifest}`,
      );
    }
  }
  return mismatched;
}

describe(`spec §42 — one file reaches the SDK`, () => {
  it('is declared as a dependency by exactly one package', () => {
    // The complement of the import rule: a second workspace member that declared the SDK would
    // pass the import assertion until the day someone used it, and by then the dependency would
    // read as established. The runtime bundle and the example apps are held to their own,
    // narrower rules by the two tests after this one.
    const declaring = packageManifests
      .filter((f) => f !== RUNTIME_BUNDLE_MANIFEST && exampleAppOf(f) === null)
      .filter((manifest) => declaresConfinedSdk(readManifest(manifest)));
    expect(declaring.sort(byName)).toEqual(
      [...new Set(ENGINE_SDK_BOUNDARIES.map((row) => row.manifest))].sort(byName),
    );
  });

  it('is declared by the runtime bundle only as the owning engine pins it', () => {
    // The exception above, held narrow. Without the first assertion a renamed or deleted bundle
    // manifest would leave an exception that excuses nothing and checks nothing.
    expect(packageManifests).toContain(RUNTIME_BUNDLE_MANIFEST);
    const bundle = readManifest(RUNTIME_BUNDLE_MANIFEST);
    expect(bundle['name']).toBe('@indx-workspace/embedded');
    expect(bundle['exports']).toEqual({
      './launch': './dist/bin.js',
      './package.json': './package.json',
    });
    expectNoConfinedSdkOutsideDependencies(bundle, RUNTIME_BUNDLE_MANIFEST);
    expect(pinMismatches(asRecord(bundle['dependencies']) ?? {}, RUNTIME_BUNDLE_MANIFEST)).toEqual(
      [],
    );
  });

  it('is declared by an example app only as the owning engine pins it, and reached by none of its files', () => {
    // ADR-0165. An example app is a customer's project whose `package.json` pins the SDK of the
    // engine it runs because `aw dev` loads that engine from the app's own install. The
    // exception is held narrow: there is an example for it to excuse, an SDK appears only in
    // `dependencies` at the owning engine's exact pin, and no file of an example resolves to one
    // (each reference resolved as the example's install would).
    const examples = packageManifests.filter((f) => exampleAppOf(f) !== null);
    expect(examples.length).toBeGreaterThan(0);
    const mismatched: string[] = [];
    for (const manifest of examples) {
      const example = readManifest(manifest);
      expectNoConfinedSdkOutsideDependencies(example, manifest);
      mismatched.push(...pinMismatches(asRecord(example['dependencies']) ?? {}, manifest));
    }
    expect(mismatched).toEqual([]);
    expect(importers.filter((file) => exampleAppOf(file) !== null)).toEqual([]);
  });

  it('is not reachable through an HTML import map', () => {
    // An import map is a resolution table for a browser, and this gate resolves markup references
    // as plain URLs. None exists today; if one is added, it must be read here before this
    // assertion is relaxed.
    const withImportMaps = tracked
      .filter((f) => classified.get(f) === 'markup')
      .filter((f) => readTracked(f).includes('importmap'));
    expect(withImportMaps).toEqual([]);
  });
});
