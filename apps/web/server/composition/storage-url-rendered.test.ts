/**
 * What `create` and `aw dev` now emit for the storage setting resolves, through the server's own
 * `resolveStorageSettings`, to the places a project used before (the storage design, §04). It reads
 * the CLI's golden `.env` files, because a package test cannot import `apps/web`, and
 * re-implementing the area mapping in the CLI would let the two drift.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  IGNORED_STORAGE_VARIABLES,
  ignoredStorageVariables,
} from '@indx-workspace/contracts/storage-settings';
import { describe, expect, it } from 'vitest';

import { resolveStorageSettings, storageAreaPlace, type StorageArea } from './config';
const AREAS: readonly StorageArea[] = ['files', 'skills', 'session-state'];

const repository = path.resolve(import.meta.dirname, '../../../..');
const fixtures = path.join(repository, 'packages/cli/src/fixtures');
const TEMPLATE = path.join(repository, 'packages/cli/templates/compose.yaml');
const ROOT_COMPOSE = path.join(repository, 'compose.yaml');

function parseEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] !== undefined) env[match[1]] = match[2] ?? '';
  }
  return env;
}

/** The `.env` `create` renders for a cloud: the CLI's golden, which `render/artefacts.test.ts` pins. */
const renderedEnvironment = (cloud: string) => parseEnvFile(path.join(fixtures, cloud, 'env'));

const exampleEnvironment = () => parseEnvFile(path.join(repository, '.env.example'));

/** The storage lines of a compose file's `web` service, exactly as written. */
function composeWebLines(file: string): Record<string, string> {
  const compose = readFileSync(file, 'utf8');
  const start = compose.indexOf('\n  web:\n') + '\n  web:\n'.length;
  const next = /^ {2}[a-z-]+:$/mu.exec(compose.slice(start));
  const web = compose.slice(start, next === null ? undefined : start + next.index);
  const lines: Record<string, string> = {};
  for (const match of web.matchAll(
    /^ {6}(AW_[A-Z_]*STORAGE[A-Z_]*|AW_SESSION_TRANSCRIPT_ROOT|AWS_REGION|OBJECT_STORAGE_[A-Z_]+): (.+)$/gmu,
  )) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) lines[key] = value;
  }
  return lines;
}

/**
 * The storage variables a compose file hands the web service, interpolated from `.env` as Compose
 * does: `${NAME:-fallback}` takes the fallback for an unset or empty value, and `${NAME:?message}`
 * refuses one, which `docker compose config` reports with the message.
 */
function composeWebEnvironment(
  env: Record<string, string>,
  file = TEMPLATE,
): Record<string, string> {
  const passed: Record<string, string> = {};
  for (const [key, value] of Object.entries(composeWebLines(file))) {
    passed[key] = value
      .replace(/^'(.*)'$/u, '$1')
      .replace(/\$\{(\w+):([-?])([^}]*)\}/gu, (_, name: string, kind: string, text: string) => {
        const set = env[name];
        if (set !== undefined && set !== '') return set;
        if (kind === '?') throw new Error(`required variable ${name} is missing a value: ${text}`);
        return text;
      });
  }
  return passed;
}

/**
 * Where the bytes of one area end up: backend, bucket or root, the effective key prefix, and how
 * the server and signed links reach it (endpoint, public endpoint, region, path style).
 */
function placeOf(env: Record<string, string>, area: StorageArea): string {
  const place = storageAreaPlace(resolveStorageSettings(env), area);
  if (place.kind !== 'at') return place.kind;
  const { location } = place;
  const keyPrefix = (prefix: string): string => (prefix === '' ? area : `${prefix}/${area}`);
  switch (location.kind) {
    case 'file':
      return `file ${path.resolve(location.root)}`;
    case 's3':
      return [
        `s3 ${location.bucket}/${keyPrefix(location.prefix)}`,
        `endpoint=${location.endpoint ?? ''}`,
        `publicEndpoint=${location.publicEndpoint ?? ''}`,
        `region=${location.region ?? ''}`,
        `pathStyle=${String(location.forcePathStyle)}`,
      ].join(' ');
    case 'gcs':
      return `gcs ${location.bucket}/${keyPrefix(location.prefix)} project=${location.projectId ?? ''}`;
    case 'azblob':
      return `azblob ${location.serviceUrl} ${location.container}/${keyPrefix(location.prefix)}`;
  }
}

const placesOf = (env: Record<string, string>) => AREAS.map((area) => placeOf(env, area));

/** The bundled SeaweedFS: the bucket, endpoint and path style main gave it through the old names. */
const SEAWEEDFS_PLACES = ['files', 'skills', 'session-state'].map(
  (area) =>
    `s3 agent-workspace/${area} endpoint=http://seaweedfs:8333 publicEndpoint=http://localhost:8333 region=us-east-1 pathStyle=true`,
);

/** A cloud bucket the SDK reaches by its own endpoint, in `region`. */
const cloudPlaces = (region: string) =>
  ['files', 'skills', 'session-state'].map(
    (area) => `s3 acme-ai-files/${area} endpoint= publicEndpoint= region=${region} pathStyle=false`,
  );

/** As on main: a local project sets no `AW_PUBLIC_URL` to check the signing host against. */
const PUBLIC_URL_UNCHECKED =
  "AW_PUBLIC_URL is not set to an http(s) URL, so the endpoint in AW_STORAGE_URL was not checked against the app's origin (the storage design, §05).";

describe('the storage setting each profile renders', () => {
  // @story US-STO-10
  it.each([
    {
      name: 'compose, local-filesystem',
      // No golden for the local-filesystem answer; `create.test.ts` pins this line.
      env: { AW_STORAGE_URL: 'file:///var/lib/agent-workspace' },
      compose: true,
      places: [
        'file /var/lib/agent-workspace/files',
        'file /var/lib/agent-workspace/skills',
        'file /var/lib/agent-workspace/sessions',
      ],
      warnings: [],
    },
    {
      name: 'compose, SeaweedFS',
      env: renderedEnvironment('local'),
      compose: true,
      places: SEAWEEDFS_PLACES,
      warnings: [PUBLIC_URL_UNCHECKED],
    },
    {
      name: 'aws',
      env: renderedEnvironment('aws'),
      compose: false,
      places: cloudPlaces('us-east-1'),
      warnings: [],
    },
    {
      name: 'gcp',
      env: renderedEnvironment('gcp'),
      compose: false,
      places: [
        'gcs acme-ai-files/files project=',
        'gcs acme-ai-files/skills project=',
        'gcs acme-ai-files/session-state project=',
      ],
      warnings: [],
    },
    {
      name: 'cloudflare',
      env: renderedEnvironment('cloudflare'),
      compose: false,
      places: cloudPlaces('auto'),
      warnings: [],
    },
    {
      name: 'vercel',
      env: renderedEnvironment('vercel'),
      compose: false,
      places: cloudPlaces('us-east-1'),
      warnings: [],
    },
  ])(
    '[US-STO-10][api][cli] $name resolves to the places it used before',
    ({ env: rendered, compose, places, warnings }) => {
      // `compose.yaml` is the web service's environment; a cloud reads `.env` directly.
      const seen = compose ? composeWebEnvironment(rendered) : rendered;
      const settings = resolveStorageSettings(seen);
      expect(settings.kind).toBe('url');
      // A new project must not start with a storage_setting_ignored warning.
      expect(settings.kind === 'url' ? settings.warnings : []).toEqual(warnings);
      expect(placesOf(seen)).toEqual(places);
    },
  );

  // @story US-STO-10
  it('[US-STO-10][api][cli] the root compose.yaml with the .env.example values resolves to the same places', () => {
    const seen = composeWebEnvironment(exampleEnvironment(), ROOT_COMPOSE);
    const settings = resolveStorageSettings(seen);

    expect(settings.kind).toBe('url');
    expect(settings.kind === 'url' ? settings.warnings : []).toEqual([PUBLIC_URL_UNCHECKED]);
    expect(placesOf(seen)).toEqual(SEAWEEDFS_PLACES);
    expect(seen['AW_STORAGE_CREATE_BUCKET']).toBe('true');
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] the SeaweedFS project asks the server to create its bucket', () => {
    expect(composeWebEnvironment(renderedEnvironment('local'))['AW_STORAGE_CREATE_BUCKET']).toBe(
      'true',
    );
  });

  // @story US-STO-10
  it.each([
    ['the template', TEMPLATE, renderedEnvironment('local')],
    ['the root compose.yaml', ROOT_COMPOSE, exampleEnvironment()],
  ])(
    '[US-STO-10][api][cli] %s forwards every old name empty, so only a leftover value warns',
    (_, file, env) => {
      const forwarded = composeWebLines(file);
      for (const name of IGNORED_STORAGE_VARIABLES) {
        expect(forwarded[name], name).toBe(`\${${name}:-}`);
      }
      // Forwarded empty, an old name is unset to the server: no warning.
      const fresh = composeWebEnvironment(env, file);
      expect(ignoredStorageVariables(fresh)).toEqual([]);

      // A leftover value reaches the server, which warns and keeps every place where it was.
      const leftover = composeWebEnvironment({ ...env, AW_FILE_STORAGE_ROOT: '/srv/old' }, file);
      const settings = resolveStorageSettings(leftover);
      expect(settings.kind === 'url' ? settings.warnings.join(' ') : '').toContain(
        'storage_setting_ignored: ignoring AW_FILE_STORAGE_ROOT;',
      );
      expect(placesOf(leftover)).toEqual(placesOf(fresh));
    },
  );

  // @story US-STO-10
  it.each([
    ['the template', TEMPLATE, 'set AW_STORAGE_URL in .env'],
    ['the root compose.yaml', ROOT_COMPOSE, 'set AW_STORAGE_URL in .env — copy .env.example'],
  ])(
    '[US-STO-10][api][cli] %s refuses to start with no AW_STORAGE_URL, and says so',
    (_, file, message) => {
      // Docker is not on every test host, so this reads the interpolation `docker compose config`
      // refuses, with the message it prints.
      expect(composeWebLines(file)['AW_STORAGE_URL']).toBe(`\${AW_STORAGE_URL:?${message}}`);
      expect(() => composeWebEnvironment({}, file)).toThrow(
        `required variable AW_STORAGE_URL is missing a value: ${message}`,
      );
    },
  );

  // @story US-STO-10
  it('[US-STO-10][api][cli] aw dev resolves to the folders it used before', () => {
    // `packages/embedded` cannot be imported; its `workspace.test.ts` pins this same literal folder.
    const url = pathToFileURL(path.resolve('.agent-workspace/storage')).href;
    expect(placesOf({ AW_STORAGE_URL: url })).toEqual(
      ['files', 'skills', 'sessions'].map(
        (area) => `file ${path.resolve('.agent-workspace/storage', area)}`,
      ),
    );
  });
});
