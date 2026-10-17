/**
 * The files wire contract now lives in `@indx-workspace/contracts/files`, the package the SDK and
 * every external consumer validate against. This module is the application's import seam: browser
 * and server code keep importing `contracts/files` while the canonical helpers move out, so the
 * migration is one file at a time rather than a flag day (`docs/sdk/03-sdk-design.md`).
 */
export {
  RESOURCE_PATH_ENCODING_HEADER,
  RESOURCE_PATH_ENCODING_PERCENT_UTF8,
  decodeResourcePathHeader,
  resourcePathHeaders,
  type DecodedResourcePathHeader,
  type ResourcePathHeaderName,
} from '@indx-workspace/contracts/files';
