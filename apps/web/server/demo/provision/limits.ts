/**
 * The most bytes one sample file of a demo template may have (internal spec, "How Try it works":
 * the provisioner's rules). The catalog test holds every `demo.seed` file to the same number, so a
 * seeded file always copies; a template file larger than this fails the copy, it is never cut.
 */
export const DEMO_SAMPLE_FILE_MAX_BYTES = 1024 * 1024;

/** The most records one read of a demo's records stand-in answers with. */
export const RECORDS_PER_ANSWER = 100;
/** The longest piece of the records' JSON one process argument carries, in characters (3 bytes each at most, well under Linux's 128 KiB per argument). */
export const ARGUMENT_PIECE_CHARACTERS = 30_000;
/**
 * The most UTF-8 bytes of records JSON one stand-in carries. Bounded in bytes, not characters, as
 * the process arguments are: 600 000 bytes is under a third of the 2 MiB a Linux process may take
 * for arguments and environment together, whatever the language of the records.
 */
export const RECORDS_JSON_MAX_BYTES = 600_000;
/**
 * The most bytes of seed one `PUT /api/demo/templates/{entry}` reads. It does not cover every seed
 * the schema allows (200 files of up to 1 MiB, base64, plus records reach about 267 MiB); it is a
 * bound for a demo's real seed (the largest today is about 40 KB), and a larger body is refused
 * with 413 before it is parsed.
 */
export const DEMO_SEED_BODY_MAX_BYTES = 32 * 1_048_576;
/** How long the one-off demo workspace lives that makes a template owner's user row. */
export const OWNER_BINDING_SECONDS = 3_600;
