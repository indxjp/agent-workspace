// shortcut: a dashboard placeholder (recent runs, file count); replace it with the dashboard's
// lists when the app kit ships them (F-5).
import { SignInRequired, Unanswered } from './notices';
import { answer, personClient } from './portal';
import { strings } from './strings';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const client = await personClient();
  if (client === null) return <SignInRequired next="/" />;
  const [runs, files] = await Promise.all([
    answer(() => client.runs.list({ limit: 5 })),
    answer(() => client.files.list()),
  ]);
  return (
    <main>
      <h1>{strings.dashboardTitle}</h1>
      <section aria-labelledby="recent-runs">
        <h2 id="recent-runs">{strings.recentRuns}</h2>
        {runs.kind !== 'ok' ? (
          <Unanswered kind={runs.kind} />
        ) : runs.value.runs.length === 0 ? (
          <p>{strings.noRuns}</p>
        ) : (
          <ul>
            {runs.value.runs.map((run) => (
              <li key={run.id}>
                <a href={`/runs/${run.id}`}>{strings.runTitle(run.id)}</a> {strings.status[run.status]}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="files">
        <h2 id="files">{strings.filesTitle}</h2>
        {files.kind === 'ok' ? (
          <p>
            <a href="/files">{strings.fileCount(files.value.length)}</a>
          </p>
        ) : (
          <Unanswered kind={files.kind} />
        )}
      </section>
    </main>
  );
}
