import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
export async function repositoryWorkflowDocuments(): Promise<Map<string, string>> {
  const directory = path.join(process.cwd(), '.github/workflows');
  const documents = new Map<string, string>();
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) continue;
    // Export-excluded: its private reusable-workflow pin lives in .github/indx-dev.actions.json, which
    // these fixtures do not load; scripts/check-workflows.mjs validates it with that file.
    if (filename === 'indx-dev.yml') continue;
    documents.set(
      `.github/workflows/${filename}`,
      await readFile(path.join(directory, filename), 'utf8'),
    );
  }
  return documents;
}

export function mutateJob(ci: string, jobId: string, mutate: (job: string) => string): string {
  const start = ci.indexOf(`\n  ${jobId}:\n`);
  if (start < 0) throw new Error(`ci.yml has no ${jobId} job`);
  const next = /\n {2}[a-zA-Z0-9_-]+:\n/gu;
  next.lastIndex = start + 1;
  const end = next.exec(ci)?.index ?? ci.length;
  const job = ci.slice(start, end);
  const mutated = mutate(job);
  if (mutated === job) throw new Error(`the mutation did not change the ${jobId} job`);
  return ci.slice(0, start) + mutated + ci.slice(end);
}
