import { describe, expect, it } from 'vitest';

import { classifyAddress } from './address.js';

describe('classifyAddress', () => {
  it.each([
    ['169.254.169.254', 'address_link_local'],
    ['169.254.0.1', 'address_link_local'],
    ['10.0.0.1', 'address_private'],
    ['172.16.0.1', 'address_private'],
    ['172.31.255.255', 'address_private'],
    ['192.168.1.1', 'address_private'],
    ['100.64.0.1', 'address_private'],
    ['127.0.0.1', 'address_loopback'],
    ['127.255.255.254', 'address_loopback'],
    ['::1', 'address_loopback'],
    ['fd00::1', 'address_unique_local'],
    ['fc00::1', 'address_unique_local'],
    ['fe80::1', 'address_link_local'],
    ['fe80::1%eth0', 'address_link_local'],
    ['0.0.0.0', 'address_reserved'],
    ['224.0.0.1', 'address_reserved'],
    ['255.255.255.255', 'address_reserved'],
    ['::', 'address_reserved'],
    ['ff02::1', 'address_reserved'],
    ['::ffff:127.0.0.1', 'address_loopback'],
    ['::ffff:7f00:1', 'address_loopback'],
    ['::ffff:169.254.169.254', 'address_link_local'],
    ['::ffff:a9fe:a9fe', 'address_link_local'],
    ['::ffff:10.0.0.1', 'address_private'],
    ['64:ff9b::a00:1', 'address_private'],
    ['64:ff9b::169.254.169.254', 'address_link_local'],
    ['::10.0.0.1', 'address_reserved'],
    ['64:ff9b:1::a00:1', 'address_reserved'],
    ['::ffff:0:a9fe:a9fe', 'address_reserved'],
    ['fec0::1', 'address_reserved'],
    ['2001:db8::1', 'address_reserved'],
    ['not an address', 'address_reserved'],
  ])('refuses %s as %s', (address, reason) => {
    expect(classifyAddress(address)).toBe(reason);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '2606:4700::1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows the public address %s', (address) => {
    expect(classifyAddress(address)).toBeNull();
  });
});
