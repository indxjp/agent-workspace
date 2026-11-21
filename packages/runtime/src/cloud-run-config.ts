import { type CloudRunDriverOptions } from './cloud-run-contract.js';
import { requireProxyBypass } from './egress.js';
import { assertDigestPinnedEngineImages } from './engine-images.js';

export function requireValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`cloud-run runtime: ${name} must be a non-empty string.`);
  }
  return value;
}

/**
 * The control-plane origin a sandbox mirrors to: http(s), with no path (a base path would move the
 * runner's requests off the load balancer's route templates), credentials, query or fragment, and
 * normalised without a trailing slash. With an egress proxy its host must be bypassed, because a
 * proxied sandbox would otherwise send the mirror's requests to the proxy, which refuses them.
 */
function requireSessionMirrorUrl(value: string, bypass: readonly string[] | undefined): string {
  const raw = requireValue(value, 'sessionMirrorUrl').trim();
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (
    url === undefined ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'cloud-run runtime: sessionMirrorUrl must be an http: or https: origin, with no path, credentials, query or fragment.',
    );
  }
  if (bypass !== undefined && !bypass.includes(url.hostname)) {
    throw new Error(
      `cloud-run runtime: sessionMirrorUrl host ${url.hostname} must be in the egress proxy bypass list, or a proxied sandbox cannot reach the control plane.`,
    );
  }
  return url.origin;
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
  const sessionMirrorUrl =
    options.sessionMirrorUrl === undefined
      ? undefined
      : requireSessionMirrorUrl(options.sessionMirrorUrl, egressProxy?.bypass);
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
    sessionMirrorUrl,
    serviceIdPrefix,
    fileIntake,
    now,
    client,
    pollIntervalMs,
    readyTimeoutMs,
  };
}
