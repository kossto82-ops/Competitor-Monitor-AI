import { describe, expect, it } from "vitest";
import { isBlockedIp } from "./ipBlocklist.js";

describe("isBlockedIp", () => {
  it.each([
    ["127.0.0.1", "IPv4 loopback"],
    ["10.0.0.5", "IPv4 private (10/8)"],
    ["172.16.4.1", "IPv4 private (172.16/12)"],
    ["192.168.1.1", "IPv4 private (192.168/16)"],
    ["169.254.169.254", "IPv4 link-local / cloud metadata"],
    ["169.254.1.1", "IPv4 link-local"],
    ["100.64.0.1", "IPv4 carrier-grade NAT"],
    ["0.0.0.0", "IPv4 unspecified"],
    ["255.255.255.255", "IPv4 broadcast"],
    ["224.0.0.1", "IPv4 multicast"],
    ["::1", "IPv6 loopback"],
    ["fc00::1", "IPv6 unique local"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:127.0.0.1", "IPv4-mapped IPv6 loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped IPv6 private"],
    ["not-an-ip", "garbage input"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ["8.8.8.8", "public IPv4"],
    ["93.184.216.34", "public IPv4 (example.com)"],
    ["2606:4700:4700::1111", "public IPv6 (Cloudflare)"],
  ])("allows %s (%s)", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});
