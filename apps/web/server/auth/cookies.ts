export function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  return header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
