/** The most bytes of files one run moves in either direction (the storage design, §04 "Size limits"). */
export const RUN_FILES_MAX_BYTES = 128 * 1024 * 1024;

/** The most archive members one `POST /files` creates, so a headers-only archive stays bounded. */
export const RUN_FILES_MAX_MEMBERS = 100_000;

export const BLOCK = 512;

export const ZERO_TRAILER = BLOCK * 2;

/**
 * The most wire bytes of one `POST /files` archive: the payload limit plus each member's header
 * and payload padding (at most one block each) and the trailer. The extractor still enforces
 * {@link RUN_FILES_MAX_BYTES} and {@link RUN_FILES_MAX_MEMBERS} on what the archive holds.
 */
export const RUN_FILES_MAX_ARCHIVE_BYTES =
  RUN_FILES_MAX_BYTES + RUN_FILES_MAX_MEMBERS * 2 * BLOCK + ZERO_TRAILER;

export type TarEntry = Readonly<{
  path: string;
  type: 'file' | 'directory';
  mode: number;
  data?: Uint8Array;
}>;

/** One member of a streamed archive. A file is opened only when its turn comes. */
export type StreamTarEntry =
  | Readonly<{ path: string; type: 'directory'; mode: number }>
  | Readonly<{
      path: string;
      type: 'file';
      mode: number;
      size: number;
      open(): Promise<ReadableStream<Uint8Array>>;
    }>;

/** Every refusal of the codec. The runner answers it with a 400; filesystem errors stay plain. */
export class ArchiveValidationError extends Error {
  override readonly name: string = 'ArchiveValidationError';
}

/** The collected files exceed the caller's byte budget. A validation error the runner answers 413. */
export class ArchiveTooLargeError extends ArchiveValidationError {
  override readonly name: string = 'ArchiveTooLargeError';
}
