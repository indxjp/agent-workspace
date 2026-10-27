/**
 * `AW_STORAGE_URL`: where the object store is, in one URL that is parsed once, here, for the server
 * and the CLI alike. A leaf with no Node built-ins, because contracts also ships to browsers.
 *
 * Passwords and keys never go in this URL; they come from the environment or the cloud's workload
 * identity. So the parser refuses any userinfo and any query parameter it does not list, and every
 * refusal reason is fixed text that never repeats the value it refused (a rejected URL ends up in
 * logs and doctor output). The path is split by hand rather than by `URL`, which resolves `..`
 * away silently and would let `s3://bucket/a/../b` escape its prefix.
 */
import { isHttpEndpoint } from './url-credential.js';

export { isHttpEndpoint } from './url-credential.js';

export type StorageLocation =
  | { kind: 'file'; root: string }
  | {
      kind: 's3';
      bucket: string;
      prefix: string;
      endpoint?: string;
      /** The endpoint signed links name, when a browser cannot reach `endpoint`. */
      publicEndpoint?: string;
      region?: string;
      forcePathStyle: boolean;
    }
  | { kind: 'gcs'; bucket: string; prefix: string; projectId?: string }
  | { kind: 'azblob'; account: string; serviceUrl: string; container: string; prefix: string };

/** `secret` is set when the URL was refused for carrying a credential or an unknown query parameter. */
export type StorageUrlRefusal = { ok: false; reason: string; secret?: true };

export type StorageUrlResult = { ok: true; location: StorageLocation } | StorageUrlRefusal;

/**
 * S3 and GCS bucket names: `[a-z0-9.-]`, 3–63 characters, no separator at either end. An
 * unanchored pattern fragment: the deployment profile's JSON Schema concatenates it, and JSON
 * Schema patterns carry no flags.
 */
export const BUCKET_NAME_PATTERN = '[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]';

/** Azure container names: `[a-z0-9-]`, 3–63 characters, no hyphen at either end, never `--`. */
export const AZURE_CONTAINER_NAME_PATTERN = '(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]';

const BUCKET = new RegExp(`^(?:${BUCKET_NAME_PATTERN})$`, 'u');
const CONTAINER = new RegExp(`^(?:${AZURE_CONTAINER_NAME_PATTERN})$`, 'u');
const ACCOUNT = /^[a-z0-9]{3,24}$/u;
const REGION = /^[A-Za-z0-9-]+$/u;
const PROJECT = /^[A-Za-z0-9._:-]+$/u;
const hasControlCharacter = (segment: string): boolean =>
  Array.from(segment).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
const DRIVE = /^[A-Za-z]:$/u;
/** Core's `storeKeyPrefix` refuses a prefix that starts like a Windows drive as absolute. */
const DRIVE_PREFIX = /^[A-Za-z]:/u;
const DRIVE_PREFIX_REASON = 'prefix must not start with a drive letter';
const URL_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(#.*)?$/u;

const QUERY_PARAMETERS = {
  file: [],
  s3: ['endpoint', 'publicEndpoint', 'region', 'pathStyle'],
  gcs: ['project'],
  azblob: ['endpoint'],
} as const;

const KNOWN_PARAMETERS: readonly string[] = Object.values(QUERY_PARAMETERS).flat();

type Scheme = keyof typeof QUERY_PARAMETERS;

function isScheme(value: string): value is Scheme {
  return Object.hasOwn(QUERY_PARAMETERS, value);
}

const refuse = (reason: string, secret?: true): StorageUrlRefusal =>
  secret === undefined ? { ok: false, reason } : { ok: false, reason, secret };

function defaultAzureServiceUrl(account: string): string {
  return `https://${account}.blob.core.windows.net`;
}

type Query = Partial<
  Record<'endpoint' | 'publicEndpoint' | 'region' | 'pathStyle' | 'project', string>
>;

/** The allowed query parameters, or a refusal. Only a listed parameter name is ever echoed, never a value. */
function readQuery(scheme: Scheme, search: string): Query | StorageUrlRefusal {
  const allowed: readonly string[] = QUERY_PARAMETERS[scheme];
  const query: Query = {};
  for (const [name, value] of new URLSearchParams(search)) {
    if (!allowed.includes(name)) {
      return KNOWN_PARAMETERS.includes(name)
        ? refuse(`query parameter "${name}" is not allowed for ${scheme}:`)
        : refuse(`an unknown query parameter is not allowed for ${scheme}:`, true);
    }
    if (Object.hasOwn(query, name))
      return refuse(`query parameter "${name}" appears more than once`);
    query[name as keyof Query] = value;
  }
  if (query.endpoint !== undefined && !isHttpEndpoint(query.endpoint)) {
    return refuse('endpoint must be an http or https URL without credentials, query, or fragment');
  }
  if (query.publicEndpoint !== undefined && !isHttpEndpoint(query.publicEndpoint)) {
    return refuse(
      'publicEndpoint must be an http or https URL without credentials, query, or fragment',
    );
  }
  if (query.region !== undefined && !REGION.test(query.region))
    return refuse('region is not valid');
  if (query.project !== undefined && !PROJECT.test(query.project))
    return refuse('project is not valid');
  if (query.pathStyle !== undefined && query.pathStyle !== 'true' && query.pathStyle !== 'false') {
    return refuse('pathStyle must be true or false');
  }
  return query;
}

/** Path segments below the bucket: no empty, `.` or `..` segment, no escapes. Trailing `/` is dropped. */
function prefixSegments(path: string): string[] | null {
  const trimmed = path.replace(/\/+$/u, '').slice(1);
  if (trimmed === '') return [];
  const segments = trimmed.split('/');
  const safe = segments.every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      !hasControlCharacter(segment) &&
      !/[\\%]/u.test(segment),
  );
  return safe ? segments : null;
}

function parseFileRoot(host: string, path: string): StorageUrlResult {
  if (host !== '' && host.toLowerCase() !== 'localhost') {
    return refuse('file: URLs must have an empty host');
  }
  if (path === '') return refuse('file: URLs must name an absolute path, as file:///path');
  let segments: string[];
  try {
    segments = path.slice(1).split('/').map(decodeURIComponent);
  } catch {
    return refuse('file: path has an invalid percent escape');
  }
  if (segments.at(-1) === '') segments.pop();
  const safe = segments.every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      !hasControlCharacter(segment) &&
      !/[\\/]/u.test(segment),
  );
  if (!safe) return refuse('file: path has an empty, relative, or escaped segment');
  const [first] = segments;
  if (first !== undefined && DRIVE.test(first)) {
    return {
      ok: true,
      location: { kind: 'file', root: segments.length === 1 ? `${first}/` : segments.join('/') },
    };
  }
  return { ok: true, location: { kind: 'file', root: `/${segments.join('/')}` } };
}

/** Parses `AW_STORAGE_URL`. Never throws; a refusal's reason never contains the input. */
// @story US-STO-10
export function parseStorageUrl(raw: string): StorageUrlResult {
  const shape = URL_SHAPE.exec(raw);
  if (shape === null) return refuse('not a storage URL; expected scheme://…');
  const [, rawScheme = '', authority = '', path = '', search = '', fragment] = shape;
  const scheme = rawScheme.toLowerCase();
  if (authority.includes('@')) return refuse('credentials do not belong in AW_STORAGE_URL', true);
  if (!isScheme(scheme)) return refuse('scheme must be one of file, s3, gcs, azblob');
  if (fragment !== undefined) return refuse('a #fragment is not allowed in a storage URL');
  const query = readQuery(scheme, search);
  if ('ok' in query) return query;

  if (scheme === 'file') return parseFileRoot(authority, path);

  if (scheme === 'azblob') {
    if (!ACCOUNT.test(authority))
      return refuse('azblob account must be 3-24 lowercase letters or digits');
    const segments = prefixSegments(path);
    if (segments === null) return refuse('path has an empty, relative, or escaped segment');
    const [container, ...rest] = segments;
    if (container === undefined || !CONTAINER.test(container)) {
      return refuse(
        'azblob URL must be azblob://account/container[/prefix] with a valid container',
      );
    }
    const prefix = rest.join('/');
    if (DRIVE_PREFIX.test(prefix)) return refuse(DRIVE_PREFIX_REASON);
    return {
      ok: true,
      location: {
        kind: 'azblob',
        account: authority,
        serviceUrl: query.endpoint ?? defaultAzureServiceUrl(authority),
        container,
        prefix,
      },
    };
  }

  if (!BUCKET.test(authority)) return refuse(`${scheme} URL must name a valid bucket`);
  const segments = prefixSegments(path);
  if (segments === null) return refuse('prefix has an empty, relative, or escaped segment');
  const prefix = segments.join('/');
  if (DRIVE_PREFIX.test(prefix)) return refuse(DRIVE_PREFIX_REASON);
  if (scheme === 'gcs') {
    return {
      ok: true,
      location: {
        kind: 'gcs',
        bucket: authority,
        prefix,
        ...(query.project === undefined ? {} : { projectId: query.project }),
      },
    };
  }
  return {
    ok: true,
    location: {
      kind: 's3',
      bucket: authority,
      prefix,
      ...(query.endpoint === undefined ? {} : { endpoint: query.endpoint }),
      ...(query.publicEndpoint === undefined ? {} : { publicEndpoint: query.publicEndpoint }),
      ...(query.region === undefined ? {} : { region: query.region }),
      forcePathStyle: query.pathStyle === 'true',
    },
  };
}

const encodePathSegment = (segment: string): string =>
  encodeURI(segment).replaceAll('?', '%3F').replaceAll('#', '%23');

const encodeQueryValue = (value: string): string =>
  encodeURIComponent(value).replaceAll('%3A', ':').replaceAll('%2F', '/');

function withQuery(base: string, parameters: [string, string | undefined][]): string {
  const pairs = parameters.flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}=${encodeQueryValue(value)}`],
  );
  return pairs.length === 0 ? base : `${base}?${pairs.join('&')}`;
}

const withPrefix = (base: string, prefix: string): string =>
  prefix === '' ? base : `${base}/${prefix}`;

/** The URL {@link parseStorageUrl} reads back to the same location. For warnings and doctor output. */
export function formatStorageUrl(location: StorageLocation): string {
  switch (location.kind) {
    case 'file':
      return `file://${DRIVE.test(location.root.slice(0, 2)) ? '/' : ''}${location.root
        .split('/')
        .map(encodePathSegment)
        .join('/')}`;
    case 's3':
      return withQuery(withPrefix(`s3://${location.bucket}`, location.prefix), [
        ['endpoint', location.endpoint],
        ['publicEndpoint', location.publicEndpoint],
        ['region', location.region],
        ['pathStyle', location.forcePathStyle ? 'true' : undefined],
      ]);
    case 'gcs':
      return withQuery(withPrefix(`gcs://${location.bucket}`, location.prefix), [
        ['project', location.projectId],
      ]);
    case 'azblob':
      return withQuery(
        withPrefix(`azblob://${location.account}/${location.container}`, location.prefix),
        [
          [
            'endpoint',
            location.serviceUrl === defaultAzureServiceUrl(location.account)
              ? undefined
              : location.serviceUrl,
          ],
        ],
      );
  }
}
