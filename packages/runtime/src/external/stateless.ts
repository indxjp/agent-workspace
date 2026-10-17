/**
 * What a stateless `external` driver derives from one secret (ADR-0126): the name that finds a
 * session's sandbox at the provider, the bearer the runner inside requires, and the sealed handle
 * id that carries the sandbox's address. A second process holding the secret recomputes all three,
 * so a manager running as a function keeps no table between invocations.
 *
 * The three uses of the secret have their own HKDF info, so a value made for one is no use for
 * another. The bearer is never sealed into an id or returned: it is recomputed from the lookup key.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const MIN_SECRET_LENGTH = 32;
const SEALED_PREFIX = 's';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = 1;

export type SealedSandbox = Readonly<{
  sandboxId: string;
  origin: string;
  accessHeaders: Readonly<Record<string, string>>;
  createdAt: number;
  expiresAt: number;
  workspacePath: string;
  lookupKey: string;
}>;

export type Sealer = Readonly<{
  lookupKey(sessionKey: string): string;
  bearer(lookupKey: string): string;
  seal(sandbox: SealedSandbox): string;
  /** The sandbox a sealed id stands for; `undefined` for any id this secret did not seal. */
  open(id: string): SealedSandbox | undefined;
}>;

function derive(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'agent-workspace/external', info, 32));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function parse(json: string, driverId: string): SealedSandbox | undefined {
  const value = JSON.parse(json) as Record<string, unknown>;
  const { v, d, x, o, h, c, e, w, k } = value;
  if (
    v !== FORMAT ||
    d !== driverId ||
    typeof x !== 'string' ||
    typeof o !== 'string' ||
    !isStringRecord(h) ||
    typeof c !== 'number' ||
    typeof e !== 'number' ||
    typeof w !== 'string' ||
    typeof k !== 'string'
  ) {
    return undefined;
  }
  return {
    sandboxId: x,
    origin: o,
    accessHeaders: h,
    createdAt: c,
    expiresAt: e,
    workspacePath: w,
    lookupKey: k,
  };
}

export function createSealer(secret: string, driverId: string): Sealer {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${driverId} runtime: the stateless seal secret must contain at least ${String(MIN_SECRET_LENGTH)} characters.`,
    );
  }
  const sealKey = derive(secret, 'seal v1');
  const macKey = derive(secret, 'lookup v1');
  const mac = (message: string): string =>
    createHmac('sha256', macKey).update(message).digest('base64url');

  return {
    lookupKey: (sessionKey) => mac(`lookup\n${driverId}\n${sessionKey}`),
    bearer: (lookupKey) => mac(`bearer\n${lookupKey}`),

    seal(sandbox) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', sealKey, iv);
      cipher.setAAD(Buffer.from(driverId));
      const body = Buffer.concat([
        cipher.update(
          JSON.stringify({
            v: FORMAT,
            d: driverId,
            x: sandbox.sandboxId,
            o: sandbox.origin,
            h: sandbox.accessHeaders,
            c: sandbox.createdAt,
            e: sandbox.expiresAt,
            w: sandbox.workspacePath,
            k: sandbox.lookupKey,
          }),
          'utf8',
        ),
        cipher.final(),
      ]);
      return SEALED_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
    },

    open(id) {
      if (!id.startsWith(SEALED_PREFIX)) return undefined;
      try {
        const raw = Buffer.from(id.slice(SEALED_PREFIX.length), 'base64url');
        if (raw.byteLength <= IV_BYTES + TAG_BYTES) return undefined;
        const decipher = createDecipheriv('aes-256-gcm', sealKey, raw.subarray(0, IV_BYTES));
        decipher.setAAD(Buffer.from(driverId));
        decipher.setAuthTag(raw.subarray(raw.byteLength - TAG_BYTES));
        const json = Buffer.concat([
          decipher.update(raw.subarray(IV_BYTES, raw.byteLength - TAG_BYTES)),
          decipher.final(),
        ]).toString('utf8');
        return parse(json, driverId);
      } catch {
        return undefined;
      }
    },
  };
}
