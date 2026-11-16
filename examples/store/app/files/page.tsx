import { cookies } from 'next/headers';

import { LANG_COOKIE, langOf } from '../lang';
import { tr } from '../text';

export default async function FilesPage() {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const t = tr(lang);
  return (
    <main>
      <h1>{t('ファイル', 'Files')}</h1>
      <p>
        {t(
          'デモのサンプルファイルは、デモのエージェントが読み取ります。ゲストの権限ではファイルを一覧できません。',
          "A demo's sample files are read by its agent. A guest cannot list files.",
        )}
      </p>
    </main>
  );
}
