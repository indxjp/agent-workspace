// Shared fixtures for the cloud-run-lane tests.

// What a firewall drop looks like: the attempt timed out before any TCP connect.
export const silent = { connected: false, timedOut: true, error: 'timed out' };
export const refused = {
  connected: false,
  timedOut: false,
  code: 'ECONNREFUSED',
  error: 'connect ECONNREFUSED 199.36.153.4:443',
};
export const reset = {
  connected: false,
  timedOut: false,
  code: 'ECONNRESET',
  error: 'read ECONNRESET',
};
export const base = () => ({
  gateway: { status: 200, connected: true },
  gatewayRunApp: silent,
  gatewayRunAppViaVip: silent,
  internet: { 'HTTP example.test at 192.0.2.1:80': silent, 'TCP 443 to 192.0.2.1': silent },
  private: { 'TCP 5432 to 10.0.0.5': silent },
  privateControl: true,
  googleVip: {
    'run.googleapis.com on private.googleapis.com': silent,
    'run.googleapis.com on restricted.googleapis.com': silent,
    'TCP 443 to private.googleapis.com (199.36.153.8)': silent,
    'TCP 80 to restricted.googleapis.com (199.36.153.4)': silent,
    'run.app service outside the project': silent,
    'GCS upload outside the project': silent,
  },
});

// Everything that proves a packet came back from the destination.
export const reachedAttempts = {
  refused,
  reset,
  'an HTTP status': { status: 403, connected: true },
  'a raw TCP connect': { connected: true },
  'a hang-up': { connected: false, error: 'socket hang up' },
  'a timeout after the connect': { connected: true, timedOut: true, error: 'timed out' },
  'a TLS error': {
    connected: true,
    code: 'ERR_SSL_WRONG_VERSION_NUMBER',
    error: 'wrong version number',
  },
};
