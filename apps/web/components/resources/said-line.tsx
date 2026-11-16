import type { FilesLocale, Said } from './files-messages';
import { saidText } from './files-messages';

/**
 * A {@link Said} line in the reader's language. English prints the parts joined, as the Files screen
 * always printed them. Another language marks each part the server or the browser worded
 * `lang="en"`, so a screen reader reads it as English (UX-15 in #2086).
 */
export function SaidLine({ said, locale }: { readonly said: Said; readonly locale: FilesLocale }) {
  if (locale === 'en') return <>{saidText(said)}</>;
  const parts = said.filter((part) => part.text !== '');
  return (
    <>
      {parts.map((part, index) => (
        // The parts of one line never reorder, so their place is a stable key.
        <span key={`${String(index)}:${part.text}`} lang={part.english === true ? 'en' : undefined}>
          {index === 0 ? '' : ' '}
          {part.text}
        </span>
      ))}
    </>
  );
}

/** The Files screen's status line: a failure, in the reader's language. */
export function FilesStatus({
  problem,
  locale,
}: {
  readonly problem: Said | null;
  readonly locale: FilesLocale;
}) {
  return problem === null ? null : (
    <p className="mb-4 text-sm text-danger" role="alert">
      <SaidLine said={problem} locale={locale} />
    </p>
  );
}
