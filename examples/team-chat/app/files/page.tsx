// shortcut: a server-rendered table of the top folder; replace it with the file browser part
// when @indx-workspace/react ships one (#253).
import { SignInRequired, Unanswered } from '../notices';
import { answer, personClient } from '../portal';
import { strings } from '../strings';

export const dynamic = 'force-dynamic';

export default async function FilesPage() {
  const client = await personClient();
  if (client === null) return <SignInRequired next="/files" />;
  const files = await answer(() => client.files.list());
  return (
    <main>
      <h1>{strings.filesTitle}</h1>
      {files.kind !== 'ok' ? (
        <Unanswered kind={files.kind} />
      ) : files.value.length === 0 ? (
        <p>{strings.noFiles}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{strings.fileName}</th>
              <th scope="col">{strings.fileSize}</th>
              <th scope="col">{strings.fileModified}</th>
            </tr>
          </thead>
          <tbody>
            {files.value.map((file) => (
              <tr key={file.id}>
                <th scope="row">{file.path}</th>
                <td>{file.sizeBytes ?? ''}</td>
                <td>{file.lastModified ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
