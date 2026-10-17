import { DismissibleNotice } from './dismissible-notice';

export interface DriverBannerProps {
  readonly driver: string;
  readonly reason: string;
  readonly warning?: boolean;
}

export const LOCAL_ISOLATION_REASON = 'No tenant isolation: commands run as the host user';

const BAND = 'border-b px-6 py-2 text-[12px]';

function bandTone(warning: boolean): string {
  return warning ? 'border-warn bg-warn-soft text-warn' : 'border-border bg-surface text-text-2';
}

export function DriverBanner({ driver, reason, warning = false }: DriverBannerProps) {
  return (
    <div
      className={`${BAND} ${bandTone(warning)}`}
      data-testid="driver-in-force"
      role={warning ? 'alert' : 'status'}
    >
      Runtime driver in force: <b>{driver}</b> — {reason}
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
}: { readonly dismissible?: boolean } = {}) {
  const configured = process.env['RUNTIME_DRIVER']?.trim();
  if (configured !== undefined && configured !== '' && configured !== 'local') return null;
  const warning = configured === 'local';
  const driver = warning ? 'local' : 'not configured';
  const reason = warning
    ? LOCAL_ISOLATION_REASON
    : 'Choose and test a runtime on the Runtimes screen';
  // Sign-in has no top bar chip, so the band is that screen's only A.3 signal and stays put.
  if (!dismissible) return <DriverBanner driver={driver} reason={reason} warning={warning} />;
  return (
    <DismissibleNotice
      id="driver"
      version={`driver=${driver}`}
      className={`${BAND} ${bandTone(warning)}`}
      role={warning ? 'alert' : 'status'}
      testId="driver-in-force"
    >
      Runtime driver in force: <b>{driver}</b> — {reason}
    </DismissibleNotice>
  );
}
