import { DismissibleNotice } from './dismissible-notice';
import { shellStrings, type ShellLocale } from './shell-messages';

export interface DriverBannerProps {
  readonly driver: string;
  readonly reason: string;
  readonly warning?: boolean;
  /** The reader's language (UX-15); English unless it is `ja`. */
  readonly locale?: ShellLocale;
}

const BAND = 'border-b px-6 py-2 text-[12px]';

function bandTone(warning: boolean): string {
  return warning ? 'border-warn bg-warn-soft text-warn' : 'border-border bg-surface text-text-2';
}

export function DriverBanner({
  driver,
  reason,
  warning = false,
  locale = 'en',
}: DriverBannerProps) {
  return (
    <div
      className={`${BAND} ${bandTone(warning)}`}
      data-testid="driver-in-force"
      role={warning ? 'alert' : 'status'}
    >
      {shellStrings(locale).driverInForce} <b>{driver}</b> — {reason}
    </div>
  );
}

/**
 * The deployment's driver band. The top bar's runtime chip is the always-on A.3 signal on shell
 * screens, so this band is dismissible per browser and per driver, and a configured driver other
 * than `local` gets no band at all — it would only repeat the chip. See
 * docs/adr/W9-UI-1133-driver-band-is-dismissible-chip-is-the-a3-signal.md.
 */
export function DeploymentDriverBanner({
  dismissible = true,
  locale = 'en',
}: { readonly dismissible?: boolean; readonly locale?: ShellLocale } = {}) {
  const strings = shellStrings(locale);
  const configured = process.env['RUNTIME_DRIVER']?.trim();
  if (configured !== undefined && configured !== '' && configured !== 'local') return null;
  const warning = configured === 'local';
  // The dismissal is remembered per driver, not per language: switching language keeps it dismissed.
  const driverKey = warning ? 'local' : 'not configured';
  const driver = warning ? 'local' : strings.runtimeNotConfigured;
  const reason = warning ? strings.localIsolation : strings.chooseRuntime;
  // Sign-in has no top bar chip, so the band is that screen's only A.3 signal and stays put.
  if (!dismissible) {
    return <DriverBanner driver={driver} reason={reason} warning={warning} locale={locale} />;
  }
  return (
    <DismissibleNotice
      id="driver"
      version={`driver=${driverKey}`}
      className={`${BAND} ${bandTone(warning)}`}
      role={warning ? 'alert' : 'status'}
      testId="driver-in-force"
      dismissLabel={strings.dismiss}
    >
      {strings.driverInForce} <b>{driver}</b> — {reason}
    </DismissibleNotice>
  );
}
