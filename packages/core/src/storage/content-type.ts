const BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  json: 'application/json',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  yaml: 'text/plain',
  yml: 'text/plain',
  js: 'text/plain',
  mjs: 'text/plain',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/plain',
  sh: 'text/plain',
  log: 'text/plain',
};

/**
 * The content type for a stored file, from its extension alone; `application/octet-stream` when
 * the extension is missing or unknown. Source code is `text/plain`, not an executable type.
 */
export function inferContentType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
