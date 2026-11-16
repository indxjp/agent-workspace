import { headers } from 'next/headers';

import { versionsLocaleOf } from '../../../../../components/agents/versions-messages';
import { EditConnectionScreen } from '../../../../../components/storage/edit-connection-screen';
import { storageStrings } from '../../../../../components/storage/storage-messages';
import { NotAllowedScreen } from '../../../../../components/shell/screen-main';
import { callerManagesStorage } from '../manages-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EditStoragePage({ params }: { params: Promise<{ id: string }> }) {
  // The reader's language (UX-15 in #2086), negotiated as the shell negotiates it.
  const locale = versionsLocaleOf((await headers()).get('accept-language'));
  const strings = storageStrings(locale);
  if (!(await callerManagesStorage())) {
    return (
      <NotAllowedScreen title={strings.editTitle} lang={locale}>
        {strings.notAllowed}
      </NotAllowedScreen>
    );
  }
  const { id } = await params;
  return <EditConnectionScreen id={id} locale={locale} />;
}
