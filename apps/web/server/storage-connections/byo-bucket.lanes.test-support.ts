import { CSV, SUMMARY } from './byo-bucket.guide.test-support';
/** Provider lanes, least-privilege probes, and isolated credentials for the own-bucket tutorial. */
import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import {
  openConnectionStore,
  streamToBytes,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { fromTokenFile } from '@aws-sdk/credential-provider-web-identity';
import type { StorageConnectionCredential } from '@indx-workspace/contracts/storage-connections';
import { formatStorageUrl, type StorageLocation } from '@indx-workspace/contracts/storage-url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';

export interface LaneSetup {
  readonly url: string;
  /** The connection's credential: least privilege, never delete. */
  readonly credential: StorageConnectionCredential;
  /** Seeds the folder and cleans it up, with a credential that may delete. */
  readonly admin: ObjectStore;
  readonly fileRoots: readonly string[];
}

export type Lane = (work: string) => Promise<LaneSetup>;

class BucketLanes {
  constructor(private readonly environment: NodeJS.ProcessEnv) {
    this.egress = loadEgressPolicyFromEnv(environment);
  }

  private readonly requireEnv = (name: string): string => {
    const value = this.environment[name];
    if (value === undefined || value.trim() === '') throw new Error(`${name} is not set`);
    return value;
  };

  /** A prefix of its own for this run, so two runs never meet and cleanup knows what it made. */
  private readonly livePrefix = (): string =>
    `aw-byo-live/${this.environment['GITHUB_RUN_ID'] ?? 'local'}-${randomBytes(4).toString('hex')}`;

  readonly egress: ReturnType<typeof loadEgressPolicyFromEnv>;

  private readonly openStore = (
    url: string,
    credential: StorageConnectionCredential,
    fileRoots: readonly string[],
  ): Promise<ObjectStore> =>
    openConnectionStore(url, credential, { writable: true, fileRoots, egress: this.egress });

  /** The ambient AWS settings a lane removes, so the connection can only use its own credential. */
  private readonly AMBIENT_AWS = [
    'AWS_ROLE_ARN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
    'AWS_EC2_METADATA_DISABLED',
  ] as const;

  readonly savedEnv = new Map<string, string | undefined>();

  /** The S3 lane's role: STS sessions as the role itself, or as the role cut down to a policy. */
  private readonly s3Role = () => {
    const bucket = this.requireEnv('TEST_AWS_S3_BUCKET');
    const region = this.requireEnv('TEST_AWS_REGION');
    const roleArn = this.requireEnv('AWS_ROLE_ARN');
    const webIdentityTokenFile = this.requireEnv('AWS_WEB_IDENTITY_TOKEN_FILE');
    const session = async (sessionPolicy?: string): Promise<StorageConnectionCredential> => {
      const identity = await fromTokenFile({
        roleArn,
        webIdentityTokenFile,
        ...(sessionPolicy === undefined ? {} : { policy: sessionPolicy }),
        clientConfig: { region },
      })();
      if (identity.sessionToken === undefined) throw new Error('STS returned no session token');
      return {
        provider: 's3',
        accessKeyId: identity.accessKeyId,
        secretAccessKey: identity.secretAccessKey,
        sessionToken: identity.sessionToken,
      };
    };
    return { bucket, region, session };
  };

  /** The guide's S3 policy for one folder: `s3:ListBucket` under the `s3:prefix` condition, get and put in it. */
  private readonly folderPolicy = (bucket: string, folder: string): string =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:ListBucket',
          Resource: `arn:aws:s3:::${bucket}`,
          Condition: { StringLike: { 's3:prefix': `${folder}/*` } },
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject'],
          Resource: `arn:aws:s3:::${bucket}/${folder}/*`,
        },
      ],
    });

  /** From here on nothing ambient can authenticate: the stores hold the explicit credentials. */
  private readonly isolateFromAmbientAws = (work: string): void => {
    for (const name of this.AMBIENT_AWS) {
      this.savedEnv.set(name, this.environment[name]);
      delete this.environment[name];
    }
    this.environment['AWS_EC2_METADATA_DISABLED'] = 'true';
    this.environment['AWS_SHARED_CREDENTIALS_FILE'] = path.join(work, 'no-aws-credentials');
    this.environment['AWS_CONFIG_FILE'] = path.join(work, 'no-aws-config');
  };

  readonly fileLane: Lane = async (work) => {
    const root = path.join(work, 'roots');
    const folder = path.join(root, 'acme-data');
    mkdirSync(folder, { recursive: true });
    const url = `file://${folder}`;
    const credential = { provider: 'file' } as const;
    return {
      url,
      credential,
      admin: await this.openStore(url, credential, [root]),
      fileRoots: [root],
    };
  };

  /** Temporary folders a test made; removed after each test. */
  readonly tempDirs: string[] = [];

  /** Runs `args` as the operator (root, through `sudo`), never as the user the server runs as. */
  private readonly asOperator = (args: readonly string[], input?: Uint8Array): void => {
    const result = spawnSync('sudo', ['-n', ...args], {
      ...(input === undefined ? {} : { input }),
      stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`sudo ${args[0] ?? ''} failed: ${String(result.stderr)}`);
    }
  };

  /**
   * The operator's view of `folder`: it seeds and cleans up as root, and reads as any user can. The
   * server, and so the connection, runs as the job's own user, which may create files in the
   * operator's sticky folder but never delete or replace one it does not own.
   */
  private readonly operatorStore = async (
    folder: string,
    url: string,
    fileRoots: readonly string[],
  ): Promise<ObjectStore> => {
    const reader = await openConnectionStore(
      url,
      { provider: 'file' },
      { writable: false, fileRoots, egress: this.egress },
    );
    const fileOf = (key: string) => path.join(folder, ...key.split('/'));
    return new Proxy(reader, {
      get: (target, name) => {
        if (name === 'write') {
          return async (key: string, body: ReadableStream<Uint8Array> | Uint8Array) => {
            const bytes = body instanceof Uint8Array ? body : await streamToBytes(body);
            this.asOperator(['install', '-d', '-m', '1777', path.dirname(fileOf(key))]);
            this.asOperator(['tee', fileOf(key)], bytes);
            return target.head(key);
          };
        }
        if (name === 'delete') {
          return (key: string) => {
            this.asOperator(['rm', '-f', fileOf(key)]);
            return Promise.resolve();
          };
        }
        const member: unknown = Reflect.get(target, name);
        return typeof member === 'function'
          ? (member as (...args: unknown[]) => unknown).bind(target)
          : member;
      },
    });
  };

  /**
   * The `file` lane with two identities (`live-e2e.yml`, `suite=storage`): the operator's root,
   * `STORAGE_LIVE_FILE_ROOT`, is owned by root with a sticky, world-writable `acme-data` folder, and
   * the connection is the server's own user, as on a host where the operator owns the shared folder.
   */
  private readonly operatorFileLane: Lane = async () => {
    const root = this.requireEnv('STORAGE_LIVE_FILE_ROOT');
    const folder = path.join(root, 'acme-data');
    const url = pathToFileURL(folder).href;
    return {
      url,
      credential: { provider: 'file' },
      admin: await this.operatorStore(folder, url, [root]),
      fileRoots: [root],
    };
  };

  /**
   * Least privilege on the `file` lane, which the cloud lanes prove with a key that has no delete:
   * the connection, opened writable as the write-back opens it, can add a file of its own but cannot
   * delete or replace one the operator owns.
   */
  readonly folderLeastPrivilege = async (prepare: Lane): Promise<void> => {
    const work = realpathSync(
      mkdtempSync(path.join(this.environment['RUNNER_TEMP'] ?? tmpdir(), 'aw-byo-')),
    );
    this.tempDirs.push(work);
    const lane = await prepare(work);
    const seeded = 'reports/operator.csv';
    const own = 'reports/own.md';
    await lane.admin.write(seeded, new Blob([CSV]).stream(), {});
    try {
      const store = await this.openStore(lane.url, lane.credential, lane.fileRoots);
      await expect(store.delete(seeded)).rejects.toThrow();
      await expect(store.write(seeded, new Blob(['tampered\n']).stream(), {})).rejects.toThrow();
      expect(await readBucketText(lane.admin, seeded)).toBe(CSV);
      await store.write(own, new Blob([SUMMARY]).stream(), { ifNoneMatch: '*' });
      expect(await readBucketText(lane.admin, own)).toBe(SUMMARY);
    } finally {
      await Promise.allSettled([lane.admin.delete(seeded), lane.admin.delete(own)]);
    }
  };

  readonly liveLanes: Readonly<Record<string, Lane>> = {
    file: this.operatorFileLane,
    s3: async (work) => {
      const { bucket, region, session } = this.s3Role();
      const prefix = this.livePrefix();
      // The connection's session is the role cut down to the guide's policy: list, get and put on
      // the prefix, never delete. The admin session is the role itself.
      const credential = await session(this.folderPolicy(bucket, prefix));
      const adminCredential = await session();
      this.isolateFromAmbientAws(work);
      const url = formatStorageUrl({ kind: 's3', bucket, prefix, region, forcePathStyle: false });
      return {
        url,
        credential,
        admin: await this.openStore(url, adminCredential, []),
        fileRoots: [],
      };
    },
    gcs: async () => {
      // The workflow's workload identity mints one short-lived access token. The connection gets it
      // as its credential; the guide's least-privilege IAM grant is what a customer's key holds. The
      // admin store uses the same token because the service account may delete, which cleanup needs.
      const accessToken = this.requireEnv('GCS_LIVE_ACCESS_TOKEN');
      const url = formatStorageUrl({
        kind: 'gcs',
        bucket: this.requireEnv('TEST_GCS_BUCKET'),
        prefix: this.livePrefix(),
        projectId: this.requireEnv('TEST_GCP_PROJECT'),
      });
      const credential = { provider: 'gcs', accessToken } as const;
      return { url, credential, admin: await this.openStore(url, credential, []), fileRoots: [] };
    },
    azblob: async () => {
      // `az` prints the service URL with a trailing slash; the account is its first host label.
      const serviceUrl = this.requireEnv('AZURE_BLOB_LIVE_SERVICE_URL').replace(/\/+$/u, '');
      const location: StorageLocation = {
        kind: 'azblob',
        account: new URL(serviceUrl).hostname.split('.')[0] ?? '',
        serviceUrl,
        container: this.requireEnv('AZURE_BLOB_LIVE_CONTAINER'),
        prefix: this.livePrefix(),
      };
      const url = formatStorageUrl(location);
      // Two user-delegation SAS tokens: `rlcw` for the connection, `rlcwd` for seeding and cleanup.
      const credential = {
        provider: 'azblob',
        sasToken: this.requireEnv('AZURE_BLOB_LIVE_SAS'),
      } as const;
      const adminSas = this.requireEnv('AZURE_BLOB_LIVE_ADMIN_SAS');
      return {
        url,
        credential,
        admin: await this.openStore(url, { provider: 'azblob', sasToken: adminSas }, []),
        fileRoots: [],
      };
    },
  };

  /**
   * The guide's own S3 shape (#1925 item 17): a prefix-less `s3://bucket?region=…` URL whose key may
   * list only one folder, `s3:ListBucket` conditioned on that folder's `s3:prefix`. Opening the store
   * must not probe the bucket root, the folder lists and reads, and a listing of the root is refused
   * with the provider's 403. The folder is the run's own prefix, so the role's grant is unchanged.
   */
  readonly prefixlessFolder = async (): Promise<void> => {
    const work = realpathSync(
      mkdtempSync(path.join(this.environment['RUNNER_TEMP'] ?? tmpdir(), 'aw-byo-')),
    );
    this.tempDirs.push(work);
    const { bucket, region, session } = this.s3Role();
    const folder = this.livePrefix();
    const credential = await session(this.folderPolicy(bucket, folder));
    const adminCredential = await session();
    this.isolateFromAmbientAws(work);
    const url = formatStorageUrl({ kind: 's3', bucket, prefix: '', region, forcePathStyle: false });
    expect(url).toBe(`s3://${bucket}?region=${region}`);
    const admin = await this.openStore(url, adminCredential, []);
    const seeded = `${folder}/q3.csv`;
    const written = `${folder}/summary.md`;
    try {
      await admin.write(seeded, new Blob([CSV]).stream(), {});
      const store = await this.openStore(url, credential, []);
      const page = await store.listPage(folder, { limit: 10 });
      expect(page.entries.map((entry) => entry.key)).toEqual([seeded]);
      expect(await readBucketText(store, seeded)).toBe(CSV);
      await store.write(written, new Blob([SUMMARY]).stream(), {});
      expect(await readBucketText(admin, written)).toBe(SUMMARY);
      const outside: unknown = await store.listPage('', { limit: 1 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(outside).toMatchObject({ $metadata: { httpStatusCode: 403 } });
      // The key has no delete, as the guide grants it.
      await expect(store.delete(written)).rejects.toMatchObject({
        $metadata: { httpStatusCode: 403 },
      });
    } finally {
      await Promise.allSettled([admin.delete(seeded), admin.delete(written)]);
    }
  };
}
export const createBucketLanes = (environment: NodeJS.ProcessEnv) => new BucketLanes(environment);

export const readBucketText = async (store: ObjectStore, key: string): Promise<string | null> => {
  const object = await store.read(key);
  return object === null ? null : Buffer.from(await streamToBytes(object.body)).toString('utf8');
};
