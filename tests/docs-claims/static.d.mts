import type { Claim } from './extract.mjs';

export const INSTALL_COMMANDS: readonly string[];
export const INSTALL_PAGES: readonly string[];
export function galleryProblems(
  claims: readonly Claim[],
  read: (file: string) => string | undefined,
): string[];
export function stackFlagProblems(siteJs: string, questionFlags: readonly string[]): string[];
export function installProblems(claims: readonly Claim[]): string[];
export function staticProblems(root: string, questionFlags: readonly string[]): string[];
