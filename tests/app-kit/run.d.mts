export const APP_NAME: string;
export const PROJECT_NAME: string;
export const SCRIPTED_MODEL: string;
export const TYPE_CHECK_PACKAGES: readonly string[];
export function withAgentWrite(source: string): string;
export function withModel(source: string, model: string): string;
export function closeTicketScript(ticketId: string | undefined): {
  turns: readonly (
    { text: string } | { toolUses: readonly { name: string; input: Record<string, unknown> }[] }
  )[];
};
export function withTarballs(
  manifest: Record<string, unknown>,
  tarballs: Record<string, string>,
): Record<string, unknown>;
export const PORTAL_PROJECT: string;
export const APP_CI_WORKFLOW: string;
export function ciRunSteps(workflow: string): string[];
export function removeWorkDirectory(directory: string): void;
export function casesOf(argv: readonly string[]): readonly string[];
export function packPackages(directory: string): Record<string, string>;
export const TEMPLATE_CASES: Readonly<
  Record<'team-chat' | 'wiki' | 'crm' | 'service-desk', string>
>;
export function readmeCommands(readme: string): string[];
export const SIGN_IN_PROOF_ROUTE: string;
export function signInProofRoute(): string;
export function pkcePair(): { verifier: string; challenge: string };
export function devIssuerCode(
  client: { issuer: string; clientId: string; redirectUri: string; challenge: string },
  person: { email: string; password: string },
): Promise<string>;
