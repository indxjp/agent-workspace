import { type CloudRunDriverOptions } from './cloud-run-contract.js';
import { requireProxyBypass } from './egress.js';
import { assertDigestPinnedEngineImages } from './engine-images.js';

export function requireValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`cloud-run runtime: ${name} must be a non-empty string.`);
  }
  return value;
}

export function resolveCloudRunOptions(
  options: Omit<CloudRunDriverOptions<never, never>, 'startAgent'>,
) {
  const images = options.images;
  if (options.requireDigest === true) assertDigestPinnedEngineImages(images, 'cloud-run');
  const project = requireValue(options.project, 'project');
  const region = requireValue(options.region, 'region');
  const serviceAccount = requireValue(options.serviceAccount, 'serviceAccount');
  // Fail closed: a sandbox without a network interface would have public egress.
  const network = requireValue(options.network, 'network');
  const subnetwork = requireValue(options.subnetwork, 'subnetwork');
  const egressProxy =
    options.egressProxy === undefined
      ? undefined
      : {
          url: requireValue(options.egressProxy.url, 'egressProxy.url'),
          key: requireValue(options.egressProxy.key, 'egressProxy.key'),
          bypass: requireProxyBypass('cloud-run', options.egressProxy.bypass),
        };
  if (egressProxy !== undefined && !/^http:\/\//iu.test(egressProxy.url)) {
    throw new Error('cloud-run runtime: egressProxy.url must be an http: URL.');
  }
  const serviceIdPrefix = options.serviceIdPrefix ?? 'rt-';
  if (!serviceIdPrefix.startsWith('rt-')) {
    throw new Error('cloud-run runtime: serviceIdPrefix must start with rt-.');
  }
  const fileIntake = options.fileIntake;
  const now = options.now ?? Date.now;
  const client =
    options.client ??
    (() => {
      throw new Error('cloud-run runtime: a CloudRunResourceClient must be supplied.');
    })();
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  return {
    images,
    project,
    region,
    serviceAccount,
    network,
    subnetwork,
    egressProxy,
    serviceIdPrefix,
    fileIntake,
    now,
    client,
    pollIntervalMs,
    readyTimeoutMs,
  };
}
