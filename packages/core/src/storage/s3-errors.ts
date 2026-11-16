/** How the S3 backend classifies an SDK error, read from its shape so this module needs no SDK. */

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

export function isNotFound(error: unknown): boolean {
  return errorName(error) === 'NoSuchKey' || httpStatus(error) === 404;
}

/**
 * A 404 for the object, not for its bucket. A bucket deleted under a store is an outage a caller
 * must see, never an absent object. A HEAD has no body to name the bucket, so only a request that
 * carries an error body (GET, copy, delete) can tell the two apart.
 */
export function isMissingObject(error: unknown): boolean {
  return isNotFound(error) && errorName(error) !== 'NoSuchBucket';
}

export function isRangeRefused(error: unknown): boolean {
  return httpStatus(error) === 416 || errorName(error) === 'InvalidRange';
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    httpStatus(error) === 412 ||
    errorName(error) === 'PreconditionFailed' ||
    errorName(error) === 'ConditionalRequestConflict'
  );
}

/** Whether a failed write is the caller's precondition failing, not a fault. */
export function isWriteConflict(error: unknown, ifMatch: string | undefined): boolean {
  // A failed If-Match on a missing key is a 404 on S3; to the caller it is the same conflict.
  // A missing bucket or upload is a deployment fault, not a stale etag.
  const missingKey =
    isNotFound(error) && errorName(error) !== 'NoSuchBucket' && errorName(error) !== 'NoSuchUpload';
  return isPreconditionFailure(error) || (ifMatch !== undefined && missingKey);
}
