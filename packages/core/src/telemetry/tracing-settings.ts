/**
 * The two tracing variables, read in one place (refactoring part 03) by the runner and gateway
 * (`startTracing`) and by web (`configureTelemetryRuntime`). Imports nothing, so the settings table
 * can list them without loading the OpenTelemetry SDK.
 */

export const OTEL_EXPORTER_OTLP_ENDPOINT_ENV_VAR = 'OTEL_EXPORTER_OTLP_ENDPOINT';
export const OTEL_SERVICE_NAME_ENV_VAR = 'OTEL_SERVICE_NAME';

export interface TracingSettings {
  /** The OTLP collector; `undefined` (unset or blank) leaves tracing off. */
  readonly endpoint: string | undefined;
  /** The service name spans carry; `undefined` means the process's own default name. */
  readonly serviceName: string | undefined;
}

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

/** Never refuses: tracing is optional, and a collector that cannot be reached is logged when it starts. */
export function readTracingSettings(
  env: Readonly<Record<string, string | undefined>>,
): TracingSettings {
  return {
    endpoint: nonBlank(env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV_VAR]),
    serviceName: nonBlank(env[OTEL_SERVICE_NAME_ENV_VAR]),
  };
}
