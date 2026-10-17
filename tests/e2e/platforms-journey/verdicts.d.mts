export type GoldenVerdict = {
  path: string;
  verdict: 'native' | 'mapped' | 'dropped';
  code?: string;
};
/** Sorted by `path`, `note` removed (prose may be reworded without changing a verdict). */
export function normaliseVerdicts(report: unknown): GoldenVerdict[];
/** One message per differing path ("+ added", "- removed", "~ changed"); [] when equal. */
export function compareWithGolden(
  actual: readonly GoldenVerdict[],
  golden: readonly GoldenVerdict[],
): string[];
/** Throws naming the missing/extra ids when the listed ids and the golden files differ. */
export function assertIdSet(listed: readonly string[], goldenIds: readonly string[]): void;
export type ListedAgent = { id: string; name: string; archived: boolean };
export type AgentsPage = { agents: ListedAgent[]; nextPage: string | null };
/** One page of the Managed Agents list (`next_page` absent = null = last page); throws on any other shape, naming top-level keys only. */
export function agentsPage(list: unknown, noun?: 'agents' | 'environments'): AgentsPage;
export type LockResources = {
  agents: string[];
  skills: string[];
  environments: string[];
  other: string[];
};
/** The agent, skill and environment ids and other resources an `ant apply` lock file records. */
export function lockResources(text: string): LockResources;
export type CleanupPlan = { commands: string[][]; problems: string[] };
/** The `ant` argv lists that remove the resources (agents, skills, environments), and a problem per unknown kind. */
export function cleanupPlan(resources: LockResources): CleanupPlan;
/** The active agent named exactly `name` on one page, or undefined. */
export function findAgentByName(list: unknown, name: string): ListedAgent | undefined;
