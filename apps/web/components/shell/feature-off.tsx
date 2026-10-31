/**
 * What a feature's page shows while the workspace has that feature switched off (ADR-0160 D8,
 * issue #1497): not a bare 404, but who can switch it back on and where. A deep link, a bookmark or
 * a crumb still reaches this page after the sidebar entry is gone, so the page is the explanation.
 * A feature the deployment does not install (`AW_DEPLOYMENT_FEATURES`) is not the Owner's to switch,
 * so its panel names the operator and offers no Settings link.
 *
 * The heading is the page's only `h1`. Colours are the design tokens the other screens use, which
 * hold their contrast in both themes.
 */
import type { FeatureId } from '@indx-workspace/contracts/features';
import Link from 'next/link';

import { featuresStrings, type FeaturesLocale } from '../workspace/features-messages';

/** Where the Features card sits: the existing Settings screen, at its `id`. */
const FEATURES_SETTINGS_HREF = '/admin/settings#features';

/** Who can bring the feature back: a workspace Owner, or only the deployment's operator. */
export type FeatureOffCause =
  | { readonly installed: false }
  | {
      readonly installed: true;
      /** Whether the caller is an Owner of the workspace, who can switch it on themselves. */
      readonly isOwner: boolean;
      readonly workspaceName: string;
    };

export function FeatureSwitchedOff({
  feature,
  cause,
  locale,
}: {
  readonly feature: FeatureId;
  readonly cause: FeatureOffCause;
  readonly locale: FeaturesLocale;
}) {
  const strings = featuresStrings(locale);
  const label = strings.labels[feature];
  if (!cause.installed) {
    return (
      <main className="w-full max-w-[1120px] px-4 pt-[26px] pb-[90px] sm:px-8">
        <section className="max-w-[640px] rounded-(--radius) border border-border bg-surface p-5">
          <h1 className="text-[18px] font-semibold text-text">
            {strings.notInstalledHeading(label)}
          </h1>
          <p className="mt-2 text-[13px] text-text-2">{strings.notInstalledOperator(label)}</p>
        </section>
      </main>
    );
  }
  return (
    <main className="w-full max-w-[1120px] px-4 pt-[26px] pb-[90px] sm:px-8">
      <section className="max-w-[640px] rounded-(--radius) border border-border bg-surface p-5">
        <h1 className="text-[18px] font-semibold text-text">{strings.offHeading(label)}</h1>
        <p className="mt-2 text-[13px] text-text-2">
          {strings.offNothingDeleted} {strings.offOwnerCanSwitch}{' '}
          <Link
            href={FEATURES_SETTINGS_HREF}
            className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            {strings.offSettingsLink}
          </Link>
          {strings.fullStop}
        </p>
        {cause.isOwner ? null : (
          <p className="mt-2 text-[13px] text-text-2">{strings.offAskOwner(cause.workspaceName)}</p>
        )}
      </section>
    </main>
  );
}
