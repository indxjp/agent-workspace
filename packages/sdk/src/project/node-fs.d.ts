/** The three `node:fs` functions `render.ts` reads the starter files with; the SDK has no Node types. */
declare module 'node:fs' {
  export function readdirSync(
    path: URL,
    options: { readonly recursive: true; readonly encoding: 'utf8' },
  ): string[];
  export function readFileSync(path: URL, encoding: 'utf8'): string;
  export function statSync(path: URL): { isFile(): boolean };
}
