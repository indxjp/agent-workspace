/**
 * The proxy modes. A sandbox with networkPolicy `restricted` or `open` reaches the world only through
 * the shared proxy; these modes run the probes from a job with the sandbox's network shape and judge
 * what the proxy let through.
 */
import { PRIVATE_GOOGLE_VIP, RESTRICTED_GOOGLE_VIP, tcpAttempt } from './attempts.mjs';
import { need } from './manager-client.mjs';
import { evaluateProxyOpen, evaluateProxyRestricted } from './proxy-evaluation.mjs';
import {
  authorityOf,
  forgeCredentials,
  parseProxyUrl,
  proxyConnect,
  proxyForward,
  settleAll,
  tunnelAndForward,
} from './proxy-attempts.mjs';

export async function proxyRestricted() {
  const proxy = parseProxyUrl(need('ISOLATION_PROXY_URL'));
  const listedUrl = new URL(need('ISOLATION_LISTED_URL'));
  const unlistedHost = need('ISOLATION_UNLISTED_HOST');
  const internetAddress = need('ISOLATION_INTERNET_ADDRESS');
  const listedAuthority = authorityOf(listedUrl.hostname, 443);

  const [listedForward, listedConnect, unlisted, direct, noCredential] = await Promise.all([
    proxyForward(proxy, listedUrl.href),
    proxyConnect(proxy, listedAuthority, { tlsServername: listedUrl.hostname }),
    settleAll({
      [`CONNECT ${authorityOf(unlistedHost, 443)}`]: proxyConnect(
        proxy,
        authorityOf(unlistedHost, 443),
      ),
      [`GET http://${unlistedHost}`]: proxyForward(proxy, `http://${unlistedHost}/`),
    }),
    settleAll({
      [`TCP 443 to ${internetAddress} without the proxy`]: tcpAttempt(internetAddress, 443),
      [`TCP 80 to ${internetAddress} without the proxy`]: tcpAttempt(internetAddress, 80),
    }),
    settleAll({
      [`CONNECT ${listedAuthority} with no credential`]: proxyConnect(
        { ...proxy, credentials: undefined },
        listedAuthority,
      ),
      [`CONNECT ${listedAuthority} with a forged token`]: proxyConnect(
        { ...proxy, credentials: forgeCredentials(proxy.credentials) },
        listedAuthority,
      ),
    }),
  ]);
  return {
    mode: 'proxy-restricted',
    results: evaluateProxyRestricted({
      listedForward,
      listedConnect,
      unlisted,
      direct,
      noCredential,
    }),
  };
}

export async function proxyOpen() {
  const proxy = parseProxyUrl(need('ISOLATION_PROXY_URL'));
  const listedUrl = new URL(need('ISOLATION_LISTED_URL'));
  const privateAddress = need('ISOLATION_PRIVATE_ADDRESS');
  const gatewayUrl = new URL(need('ISOLATION_GATEWAY_URL'));
  const metadataHeaders = { 'Metadata-Flavor': 'Google' };

  const [publicForward, publicConnect, privateTarget, metadata, googleVip, gatewayIlb] =
    await Promise.all([
      proxyForward(proxy, listedUrl.href),
      proxyConnect(proxy, authorityOf(listedUrl.hostname, 443), {
        tlsServername: listedUrl.hostname,
      }),
      settleAll({
        ...tunnelAndForward(proxy, privateAddress, 5432),
        ...tunnelAndForward(proxy, privateAddress, 80),
      }),
      settleAll({
        ...Object.fromEntries(
          ['169.254.169.254', 'metadata.google.internal'].map((host) => [
            `GET http://${host}:80`,
            proxyForward(proxy, `http://${host}:80/computeMetadata/v1/`, metadataHeaders),
          ]),
        ),
        ...Object.fromEntries(
          ['169.254.169.254', 'metadata.google.internal'].map((host) => [
            `CONNECT ${host}:443`,
            proxyConnect(proxy, authorityOf(host, 443)),
          ]),
        ),
      }),
      settleAll(
        Object.fromEntries(
          [
            PRIVATE_GOOGLE_VIP,
            RESTRICTED_GOOGLE_VIP,
            'private.googleapis.com',
            'restricted.googleapis.com',
          ].map((host) => [`CONNECT ${host}:443`, proxyConnect(proxy, authorityOf(host, 443))]),
        ),
      ),
      settleAll(tunnelAndForward(proxy, gatewayUrl.hostname, 80)),
    ]);
  return {
    mode: 'proxy-open',
    results: evaluateProxyOpen({
      publicForward,
      publicConnect,
      privateTarget,
      metadata,
      googleVip,
      gatewayIlb,
    }),
  };
}
