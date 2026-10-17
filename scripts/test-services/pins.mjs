import { TestServicesError } from './errors.mjs';

// PostgreSQL 17 for the Docker path. The native path uses the `embedded-postgres` pin in
// packages/embedded/package.json (17.10), so both run PostgreSQL 17.
export const POSTGRES_IMAGE = 'postgres:17-alpine';

// SeaweedFS (docs/adr/0066-the-s3-contract-suite-runs-against-seaweedfs.md). The image and the
// release binaries are the same release, 4.47: the image is pinned by its multi-arch index digest,
// each binary archive by its SHA-256. The CI step "Start the S3 test server for the object-store
// contract suite" pins the same digest. An upgrade changes the version, the digest, every SHA-256
// below and that CI step together; tests/test-services.test.ts fails while they disagree.
export const SEAWEEDFS_VERSION = '4.47';
export const SEAWEEDFS_IMAGE =
  'chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882';

/**
 * Release archives of https://github.com/seaweedfs/seaweedfs/releases/tag/4.47, keyed by Node's
 * `${process.platform}-${process.arch}`. Each contains the single `weed` binary.
 *
 * @type {Readonly<Record<string, { asset: string; sha256: string }>>}
 */
export const SEAWEEDFS_RELEASE_ASSETS = Object.freeze({
  'linux-arm64': {
    asset: 'linux_arm64.tar.gz',
    sha256: 'ba5c9def9ff98f78becdf309a50a9f906922f6383a7c4c772d01ede3cc012e16',
  },
  'linux-x64': {
    asset: 'linux_amd64.tar.gz',
    sha256: '31fb804858885f9e7f18b6d3b1da09e824baac3e6a55b5a62c3c4c77e6ed6d7d',
  },
  'darwin-arm64': {
    asset: 'darwin_arm64.tar.gz',
    sha256: '3ad466db33e83d0b103f90a06997feeb1cc42fd536e6cbdcdded975778f64fda',
  },
  'darwin-x64': {
    asset: 'darwin_amd64.tar.gz',
    sha256: '45475223d51b78efb413cb7a29c005c7e9e0cc3f0dfe13d10413e7f85c479b6a',
  },
});

/**
 * @param {string} platform
 * @param {string} arch
 * @returns {{ asset: string; sha256: string; url: string }}
 */
export function seaweedfsAssetFor(platform, arch) {
  const key = `${platform}-${arch}`;
  const pin = Object.hasOwn(SEAWEEDFS_RELEASE_ASSETS, key)
    ? SEAWEEDFS_RELEASE_ASSETS[key]
    : undefined;
  if (pin === undefined) {
    throw new TestServicesError(
      'seaweedfs_platform_unsupported',
      `No pinned SeaweedFS ${SEAWEEDFS_VERSION} binary for ${key}. Supported hosts: ${Object.keys(SEAWEEDFS_RELEASE_ASSETS).join(', ')}. Use Docker, or set TEST_S3_ENDPOINT to an S3 server you run yourself.`,
    );
  }
  return {
    ...pin,
    url: `https://github.com/seaweedfs/seaweedfs/releases/download/${SEAWEEDFS_VERSION}/${pin.asset}`,
  };
}
