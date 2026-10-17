/** `pac copilot init`'s derivation: `<prefix>_<camelCase(name)>`; a leading digit gets an `a`. */
export function schemaNameOf(prefix: string, agentName: string): string {
  const [first = '', ...rest] = agentName.split('-').filter((part) => part !== '');
  const camel =
    first + rest.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');
  const letterFirst = /^[0-9]/u.test(camel) ? `a${camel}` : camel;
  return `${prefix}_${letterFirst.slice(0, 64)}`;
}

/** A file-name-safe slug of a URL's host and path: `https://help.example.com/a/b` → `help-example-com-a-b`. */
export function slugOf(url: string): string {
  const { host, pathname } = new URL(url);
  const slug = `${host}${pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug === '' ? 'site' : slug;
}

/** A portable agent name from a display name or folder: `Support Triage` → `support-triage`; `''` if nothing is left. */
export function kebabOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '');
}
