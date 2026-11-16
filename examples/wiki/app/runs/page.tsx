import { SignInRequired, Unanswered } from '../notices';
import { answer, personClient } from '../portal';
import { strings } from '../strings';

export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  const client = await personClient();
  if (client === null) return <SignInRequired next="/runs" />;
  const runs = await answer(() => client.runs.list({ limit: 50 }));
  return (
    <main>
      <h1>{strings.runsTitle}</h1>
      {runs.kind !== 'ok' ? (
        <Unanswered kind={runs.kind} />
      ) : runs.value.runs.length === 0 ? (
        <p>{strings.noRuns}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{strings.runsTitle}</th>
              <th scope="col">{strings.runStatus}</th>
              <th scope="col">{strings.runStarted}</th>
            </tr>
          </thead>
          <tbody>
            {runs.value.runs.map((run) => (
              <tr key={run.id}>
                <th scope="row">
                  <a href={`/runs/${run.id}`}>{strings.runTitle(run.id)}</a>
                </th>
                <td>{strings.status[run.status]}</td>
                <td>{run.startedAt ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
