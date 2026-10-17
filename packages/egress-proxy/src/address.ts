import { BlockList, isIP } from 'node:net';

export type DeniedAddressReason =
  | 'address_loopback'
  | 'address_private'
  | 'address_link_local'
  | 'address_unique_local'
  | 'address_reserved';

type Range = readonly [network: string, prefix: number];

const IPV4_RANGES: readonly (readonly [DeniedAddressReason, readonly Range[]])[] = [
  ['address_loopback', [['127.0.0.0', 8]]],
  // 169.254.169.254, the cloud metadata endpoint, is inside this range.
  ['address_link_local', [['169.254.0.0', 16]]],
  [
    'address_private',
    [
      ['10.0.0.0', 8],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
      ['100.64.0.0', 10],
    ],
  ],
  [
    'address_reserved',
    [
      ['0.0.0.0', 8],
      ['192.0.0.0', 24],
      ['198.18.0.0', 15],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ],
  ],
];

const IPV6_RANGES: readonly (readonly [DeniedAddressReason, readonly Range[]])[] = [
  ['address_loopback', [['::1', 128]]],
  ['address_link_local', [['fe80::', 10]]],
  ['address_unique_local', [['fc00::', 7]]],
  [
    'address_reserved',
    [
      ['::', 96],
      ['ff00::', 8],
      // NAT64 local-use (64:ff9b:1::/48) and documentation (2001:db8::/32, inside 2000::/3) are never public.
      ['64:ff9b:1::', 48],
      ['2001:db8::', 32],
    ],
  ],
];

function blockLists(
  ranges: readonly (readonly [DeniedAddressReason, readonly Range[]])[],
  family: 'ipv4' | 'ipv6',
): readonly (readonly [DeniedAddressReason, BlockList])[] {
  return ranges.map(([reason, subnets]) => {
    const list = new BlockList();
    for (const [network, prefix] of subnets) list.addSubnet(network, prefix, family);
    return [reason, list];
  });
}

const IPV4_DENIED = blockLists(IPV4_RANGES, 'ipv4');
const IPV6_DENIED = blockLists(IPV6_RANGES, 'ipv6');

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): readonly number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (dotted !== null) {
    const [, a = 0, b = 0, c = 0, d = 0] = dotted.map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail, extra] = text.split('::');
  if (extra !== undefined) return null;
  const front = head === '' ? [] : head.split(':');
  const back = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? [] : Array<string>(8 - front.length - back.length).fill('0');
  const groups = [...front, ...fill, ...back].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 ? groups : null;
}

/** The IPv4 address an IPv6 address carries as IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d). */
function embeddedIpv4(groups: readonly number[]): string | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (!mapped && !nat64) return null;
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

function firstMatch(
  lists: readonly (readonly [DeniedAddressReason, BlockList])[],
  address: string,
  family: 'ipv4' | 'ipv6',
): DeniedAddressReason | null {
  for (const [reason, list] of lists) if (list.check(address, family)) return reason;
  return null;
}

/**
 * Why a sandbox may not connect to `address`, or null when it is a public unicast address. An
 * IPv6 address that carries an IPv4 one is judged by the IPv4 address, so `::ffff:169.254.169.254`
 * is as refused as `169.254.169.254`. A string that is no IP address at all is `address_reserved`:
 * the proxy never dials something it cannot classify.
 */
export function classifyAddress(address: string): DeniedAddressReason | null {
  const bare = address.split('%')[0] ?? '';
  if (isIP(bare) === 4) return firstMatch(IPV4_DENIED, bare, 'ipv4');
  const groups = ipv6Groups(bare);
  if (groups === null) return 'address_reserved';
  const embedded = embeddedIpv4(groups);
  if (embedded !== null) return firstMatch(IPV4_DENIED, embedded, 'ipv4');
  const denied = firstMatch(IPV6_DENIED, bare, 'ipv6');
  if (denied !== null) return denied;
  // Allow-only: global unicast is 2000::/3 (top three bits 001); everything else is reserved.
  return (groups[0] ?? 0) >> 13 === 1 ? null : 'address_reserved';
}
