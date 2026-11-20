import { readFile } from 'node:fs/promises';

export const repository = new URL('../../', import.meta.url);

/** Reads a repository file with every run of whitespace collapsed to one space. */
export async function readCollapsed(relative: string): Promise<string> {
  return (await readFile(new URL(relative, repository), 'utf8')).replace(/\s+/gu, ' ');
}

/** Reads a page of the developer docs site (`docs/sdk/site/`), whitespace collapsed. */
export function readSitePage(relative: string): Promise<string> {
  return readCollapsed(`docs/sdk/site/${relative}`);
}

/** Reads a platform guide (`docs/sdk/site/platforms/`), whitespace collapsed. */
export function readPlatformPage(relative: string): Promise<string> {
  return readSitePage(`platforms/${relative}`);
}
