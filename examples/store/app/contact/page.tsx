import { appRuntime } from '@indx-workspace/app/server';
import { cookies } from 'next/headers';

import { CATALOG } from '../../catalog/index.ts';
import type { Query } from '../browse';
import { parseSetup, setupSummary } from '../customize';
import { LANG_COOKIE, langOf, pick } from '../lang';
import { LeadForm } from '../lead-form';
import { tr } from '../text';

export const dynamic = 'force-dynamic';

const one = (value: Query[string]): string | undefined =>
  typeof value === 'string' ? value : value?.[0];

/** The enquiry form, prefilled with the entry and the setup a visitor chose on its Customize tab. */
export default async function ContactPage({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}) {
  const lang = langOf((await cookies()).get(LANG_COOKIE)?.value);
  const t = tr(lang);
  const query = await searchParams;
  const entry = CATALOG.find((candidate) => candidate.slug === one(query['entry']));
  const setup = entry === undefined ? undefined : parseSetup(entry, one(query['setup']));
  const summary =
    entry === undefined
      ? []
      : [
          `${t('対象', 'About')}: ${pick(entry.name, lang)}`,
          ...(setup === undefined ? [] : setupSummary(entry, setup, lang)),
        ];
  return (
    <main className="store-main">
      <h1>{t('相談する', 'Talk to us')}</h1>
      <p>
        {t(
          '導入のご相談、カスタマイズのご要望、データの削除や開示のご請求は、このフォームからお送りください。',
          'Use this form to ask about installing an agent, to ask for a customisation, or to ask us to delete or show the data we hold about you.',
        )}
      </p>
      <LeadForm
        kind="enquiry"
        lang={lang}
        platformUrl={appRuntime().awUrl}
        summary={summary}
        {...(entry === undefined ? {} : { entry: entry.slug })}
        {...(setup === undefined ? {} : { setup })}
      />
    </main>
  );
}
