import { describe, expect, it } from 'vitest';

import {
  parseContainerIdleStopSeconds,
  parseTrustedProxyHops,
  readWebSettings,
  SettingsError,
} from './settings';

describe('web settings (refactoring part 03)', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['  ', null],
    ['0', null],
    ['1', 1],
    [' 2 ', 2],
    ['16', 16],
  ])('accepts the proxy count %j as %j', (raw, value) => {
    expect(parseTrustedProxyHops(raw)).toEqual({ ok: true, value });
  });

  it.each(['several', '17', '-1', '1.5', '1e1', '0x2'])('refuses the proxy count %j', (raw) => {
    const parsed = parseTrustedProxyHops(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(`AW_TRUSTED_PROXY_HOPS is "${raw}"`);
  });

  it.each([
    [undefined, null],
    ['', null],
    ['  ', null],
    ['16', 16],
    ['900', 900],
  ])('accepts the idle stop %j as %j', (raw, value) => {
    expect(parseContainerIdleStopSeconds(raw)).toEqual({ ok: true, value });
  });

  it.each(['0', '15', '-900', '9.5', '1e3', 'soon'])('refuses the idle stop %j', (raw) => {
    const parsed = parseContainerIdleStopSeconds(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('above 15');
  });

  it('reads every setting from the environment', () => {
    expect(readWebSettings({})).toEqual({ trustedProxyHops: null, containerIdleStopSeconds: null });
    expect(
      readWebSettings({ AW_TRUSTED_PROXY_HOPS: '1', AW_CONTAINER_IDLE_STOP_SECONDS: '900' }),
    ).toEqual({ trustedProxyHops: 1, containerIdleStopSeconds: 900 });
  });

  it('names every refused variable in one error', () => {
    const read = () =>
      readWebSettings({ AW_TRUSTED_PROXY_HOPS: 'two', AW_CONTAINER_IDLE_STOP_SECONDS: '10' });
    expect(read).toThrow(SettingsError);
    expect(read).toThrow(/AW_TRUSTED_PROXY_HOPS is "two".*AW_CONTAINER_IDLE_STOP_SECONDS is "10"/u);
  });

  it('refuses one bad variable while the other is fine', () => {
    expect(() => readWebSettings({ AW_TRUSTED_PROXY_HOPS: 'two' })).toThrow(
      'AW_TRUSTED_PROXY_HOPS is "two"',
    );
    expect(() => readWebSettings({ AW_CONTAINER_IDLE_STOP_SECONDS: 'soon' })).toThrow(
      'AW_CONTAINER_IDLE_STOP_SECONDS is "soon"',
    );
  });
});
