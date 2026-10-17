/**
 * `secrets` — envelope-encrypted values (spec §23, §26, §27).
 *
 * §23 forbids provider credentials in "agent definitions / skill files / MCP files /
 * database-visible JSON / frontend responses" and says the default implementation "may encrypt
 * values in PostgreSQL using a deployment-level master key". This table is that store.
 *
 * **This file does not encrypt anything.** W2-CP-02 owns `packages/core/src/secrets/**` and
 * implements the cryptography. What this file owns is the *shape*, and the shape is chosen so
 * that writing a plaintext secret into it is awkward rather than merely discouraged:
 *
 *   1. There is no column a plaintext value fits. Every value-bearing column is `bytea`, so a
 *      caller holding a `string` has to encode it deliberately before the driver will take it.
 *   2. The ciphertext is useless without three companions — a wrapped data key, and a nonce and
 *      an authentication tag for each of the two encryptions — and each of them is CHECKed to
 *      its exact byte length, so a row that carries a value and no envelope around it is
 *      refused by constraint name.
 *   3. `master_key_id` records *which* deployment master key wrapped the data key, so rotation
 *      is a re-wrap of the data keys rather than a re-encryption of every value. A row that
 *      names no master key is rejected.
 *
 * **What these CHECKs do NOT do, stated because an earlier revision of this comment claimed
 * they did:** they do not stop a caller who never ran AES-256-GCM. The sizes are the only thing
 * asserted, and constant bytes of the right length satisfy them. Measured against
 * `postgres:17-alpine` (17.11) with the migration applied: a row whose `wrapped_data_key`,
 * nonces and tags are all zeroes and whose `ciphertext` is `convert_to('sk-ant-…','UTF8')` was
 * accepted, and `convert_from(ciphertext,'UTF8')` read the secret straight back. This file's own
 * test fixture is the same counterexample — `seed.test.ts`'s `goodEnvelope` fabricates every
 * companion with `Buffer.alloc` and sets `ciphertext` to `'not-really-encrypted'`, and the suite
 * asserts that row is accepted.
 *
 * What the shape is, then, is a positive assertion about the PARTS an envelope has — the row
 * must carry all seven of them, at the right sizes, naming a master key — and never a proof
 * that the ciphertext is a ciphertext. No database constraint can be that, because AES-256-GCM
 * output is the same length as its input. The property that a secret value is genuinely
 * encrypted belongs to W2-CP-02 and is proved by its acceptance, not here. That limit is also
 * recorded in docs/adr/W2-DB-01-remaining-section-27-tables.md.
 *
 * The envelope is fixed at AES-256-GCM for both layers (§26 wants a credential store, not a
 * cryptographic toolkit). `algorithm` exists so that widening it later is a CHECK change and a
 * per-row decision, not a silent reinterpretation of every existing row.
 */
import { check, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea, createdAt, primaryKeyId, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { workspaces } from './workspaces.js';

/**
 * The envelope algorithms this schema accepts. One entry today, deliberately: a closed set with
 * one member is a decision that has to be re-taken to be widened, which is the point.
 */
export const secretAlgorithms = ['aes-256-gcm'] as const;
export type SecretAlgorithm = (typeof secretAlgorithms)[number];

/** AES-GCM's nonce, in bytes. NIST SP 800-38D §5.2.1.1 recommends 96 bits. */
export const SECRET_NONCE_BYTES = 12;
/** AES-GCM's authentication tag, in bytes — the full 128-bit tag. */
export const SECRET_TAG_BYTES = 16;
/** An AES-256 data key is 32 bytes, and GCM ciphertext is the same length as its plaintext. */
export const SECRET_WRAPPED_DATA_KEY_BYTES = 32;

export const secrets = pgTable(
  'secrets',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /**
     * §23's examples are environment-variable shaped — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` —
     * because that is how a secret reaches a runtime. The CHECK holds them to that shape.
     */
    name: text('name').notNull(),
    algorithm: text('algorithm', { enum: secretAlgorithms }).notNull(),
    /**
     * Which deployment master key wrapped {@link wrappedDataKey}. Free-form, because the
     * deployment names its own keys; non-blank, because a row that cannot say which key opens
     * it is a row nobody can decrypt.
     */
    masterKeyId: text('master_key_id').notNull(),
    /** The per-secret data key, encrypted under the deployment master key. */
    wrappedDataKey: bytea('wrapped_data_key').notNull(),
    /** The nonce used to wrap the data key. */
    wrappedDataKeyNonce: bytea('wrapped_data_key_nonce').notNull(),
    /** The authentication tag from wrapping the data key. */
    wrappedDataKeyTag: bytea('wrapped_data_key_tag').notNull(),
    /** The secret value, encrypted under the data key. Never a plaintext. */
    ciphertext: bytea('ciphertext').notNull(),
    /** The nonce used to encrypt the value. */
    ciphertextNonce: bytea('ciphertext_nonce').notNull(),
    /** The authentication tag from encrypting the value. */
    ciphertextTag: bytea('ciphertext_tag').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('secrets_workspace_name_key').on(table.workspaceId, table.name),
    // The target `mcp_servers_credential_secret_workspace_fk` needs; see agents.ts for why this
    // is a table CONSTRAINT and not a unique INDEX.
    unique('secrets_id_workspace_key').on(table.id, table.workspaceId),
    check('secrets_name_shape', sql`${table.name} ~ '^[A-Z][A-Z0-9_]{0,127}$'`),
    check('secrets_master_key_id_not_blank', sql`length(btrim(${table.masterKeyId})) > 0`),
    oneOf('secrets_algorithm_valid', table.algorithm, secretAlgorithms),
    // The envelope's fixed-size parts, at their exact sizes. These assert that all seven parts
    // are present and correctly sized. They do NOT assert that the bytes came from AES-256-GCM;
    // constant bytes of the right length pass (see the header).
    check(
      'secrets_wrapped_data_key_size',
      sql`octet_length(${table.wrappedDataKey}) = ${sql.raw(String(SECRET_WRAPPED_DATA_KEY_BYTES))}`,
    ),
    check(
      'secrets_nonce_sizes',
      sql`octet_length(${table.wrappedDataKeyNonce}) = ${sql.raw(String(SECRET_NONCE_BYTES))} and octet_length(${table.ciphertextNonce}) = ${sql.raw(String(SECRET_NONCE_BYTES))}`,
    ),
    check(
      'secrets_tag_sizes',
      sql`octet_length(${table.wrappedDataKeyTag}) = ${sql.raw(String(SECRET_TAG_BYTES))} and octet_length(${table.ciphertextTag}) = ${sql.raw(String(SECRET_TAG_BYTES))}`,
    ),
    // An empty ciphertext is an empty secret, which is not a secret anybody meant to store.
    check('secrets_ciphertext_not_empty', sql`octet_length(${table.ciphertext}) > 0`),
    // No constraint here compares the two nonces. They encrypt under two DIFFERENT keys — the
    // master key and the data key — so their being equal is not nonce reuse and forbidding it
    // would assert a property that is not a property.
  ],
);

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
