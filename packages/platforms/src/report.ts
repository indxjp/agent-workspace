import type { FieldVerdict, PlatformId } from '@indx-workspace/contracts/platforms';

function cell(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n|\r/gu, ' ');
}

function table(rows: readonly (readonly [field: string, entry: FieldVerdict])[]): string[] {
  return [
    '| Field | Verdict | Code | Why |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      ([field, entry]) =>
        `| ${cell(field)} | ${entry.verdict} | ${entry.code ?? ''} | ${cell(entry.note)} |`,
    ),
  ];
}

/** The agent a path belongs to: agent names never contain a dot, and `toolEndpoint` has none. */
function agentOf(path: string): string | null {
  const dot = path.indexOf('.');
  return dot < 0 ? null : path.slice(0, dot);
}

/**
 * The Markdown tables of a verdict report, in report order, then a one-line count. The API's and the
 * CLI's `PLATFORM_REPORT.md` both carry this. A report that spans two or more agents is grouped: a
 * `Project` section for project-level fields, then one section per agent (in order of first
 * appearance) with the agent prefix removed from the field. A one-agent report is a single table.
 */
export function formatPlatformReport(
  platform: PlatformId,
  report: readonly FieldVerdict[],
): string {
  const count = (verdict: FieldVerdict['verdict']): number =>
    report.filter((entry) => entry.verdict === verdict).length;
  const agents = [...new Set(report.flatMap((entry) => agentOf(entry.path) ?? []))];
  const sections: string[][] = [];
  if (agents.length < 2) {
    sections.push(table(report.map((entry) => [entry.path, entry])));
  } else {
    const project = report.filter((entry) => agentOf(entry.path) === null);
    if (project.length > 0) {
      sections.push(['## Project', '', ...table(project.map((entry) => [entry.path, entry]))]);
    }
    for (const agent of agents) {
      const rows = report
        .filter((entry) => agentOf(entry.path) === agent)
        .map((entry): [string, FieldVerdict] => [entry.path.slice(agent.length + 1), entry]);
      sections.push([`## Agent \`${agent}\``, '', ...table(rows)]);
    }
  }
  return [
    `# Platform report: ${platform}`,
    '',
    ...sections.flatMap((section, index) => (index === 0 ? section : ['', ...section])),
    '',
    `${count('native')} native · ${count('mapped')} mapped · ${count('dropped')} dropped`,
    '',
  ].join('\n');
}
