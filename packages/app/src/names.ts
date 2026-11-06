/**
 * The name grammars the app kit's definitions share. Every resource, field and enum value name
 * becomes a PostgreSQL identifier or literal, so each is snake_case and at most 63 bytes (the
 * identifier limit): it needs no quoting rules and splices into generated SQL safely.
 */
import { z } from 'zod';

/** A lowercase snake_case name starting with a letter. */
export const SNAKE_CASE = /^[a-z][a-z0-9_]*$/u;

/** PostgreSQL's identifier limit, in bytes; the names here are ASCII, so in characters too. */
export const IDENTIFIER_MAX = 63;

/** A snake_case identifier of 1–63 characters. */
export const SnakeCaseNameSchema = z
  .string()
  .min(1)
  .max(IDENTIFIER_MAX)
  .regex(SNAKE_CASE, 'must be snake_case: a lowercase letter, then letters, digits or "_"');
