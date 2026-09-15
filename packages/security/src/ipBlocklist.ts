import ipaddr from "ipaddr.js";

/**
 * Whitelist, not a blocklist: only addresses ipaddr.js classifies as
 * plain public unicast are allowed. Every other range name (private,
 * loopback, linkLocal - which covers the 169.254.169.254 cloud metadata
 * address, uniqueLocal, multicast, reserved, carrierGradeNat,
 * unspecified, broadcast, ipv4Mapped edge cases, ...) is blocked.
 *
 * Whitelisting is deliberate: a blocklist has to name every dangerous
 * range and stays correct only until IANA defines a new reserved block;
 * a whitelist of "only unicast is fine" fails closed on anything new.
 */
const ALLOWED_RANGES = new Set(["unicast"]);

export function isBlockedIp(rawIp: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(rawIp);
  } catch {
    // Not parseable as an IP at all - treat as unsafe rather than let it through.
    return true;
  }

  const range = addr.range();
  return !ALLOWED_RANGES.has(range);
}

export function explainBlockedIp(rawIp: string): string {
  try {
    const addr = ipaddr.process(rawIp);
    return `Address ${rawIp} resolved to range "${addr.range()}", which is not a routable public address.`;
  } catch {
    return `Address ${rawIp} could not be parsed as a valid IP address.`;
  }
}
