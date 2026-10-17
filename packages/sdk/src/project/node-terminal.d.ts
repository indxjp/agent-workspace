/** The two Node functions `choose.ts` reads a keypress and paints with; the SDK has no Node types. */
declare module 'node:readline' {
  export function emitKeypressEvents(stream: never): void;
}
declare module 'node:util' {
  export function stripVTControlCharacters(text: string): string;
  export function styleText(
    format: string | readonly string[],
    text: string,
    options?: { readonly validateStream?: boolean },
  ): string;
}
