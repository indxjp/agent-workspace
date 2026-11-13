import { describe, expect, it } from 'vitest';

import { readTracingSettings } from './tracing-settings.js';

describe('readTracingSettings', () => {
  it('leaves tracing off when the endpoint is unset or blank', () => {
    expect(readTracingSettings({})).toEqual({ endpoint: undefined, serviceName: undefined });
    expect(readTracingSettings({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' }).endpoint).toBeUndefined();
  });

  it('trims the endpoint and the service name', () => {
    expect(
      readTracingSettings({
        OTEL_EXPORTER_OTLP_ENDPOINT: ' http://collector:4318 ',
        OTEL_SERVICE_NAME: ' aw ',
      }),
    ).toEqual({ endpoint: 'http://collector:4318', serviceName: 'aw' });
  });

  it('treats a blank service name as unset, so the process keeps its own name', () => {
    expect(readTracingSettings({ OTEL_SERVICE_NAME: '' }).serviceName).toBeUndefined();
  });
});
