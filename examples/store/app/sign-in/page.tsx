import { appRuntime } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';

import { LANG_COOKIE, langOf } from '../lang';
import { VerifyLink } from './verify';

export const dynamic = 'force-dynamic';

/** The email link's landing page (spec "Email-link sign-in"): the link's parts are in the fragment. */
export default async function SignInPage() {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  return <VerifyLink lang={lang} platformUrl={appRuntime().awUrl} />;
}
