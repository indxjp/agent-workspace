export class ClaimError extends Error {
  constructor(message: string);
}

export type ClaimState = 'run' | 'compile' | 'file' | 'illustrative' | 'generated';

export type ClaimShell = 'posix' | 'powershell';

export interface Claim {
  readonly page: string;
  readonly line: number;
  readonly state: ClaimState;
  readonly lang: string;
  readonly body: string;
  readonly title: string;
  readonly file?: string;
  readonly shell?: ClaimShell;
}

export function parseFenceInfo(info: string): {
  lang: string;
  title: string;
  claim: string | undefined;
  file: string | undefined;
  shell: string | undefined;
};
export function extractClaims(page: string, text: string): Claim[];
export function claimPages(root: string): string[];
export function extractRepositoryClaims(root: string): Claim[];
export function shellCommands(body: string): string[];
