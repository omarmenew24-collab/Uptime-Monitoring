import dns from 'dns/promises';
import ipaddr from 'ipaddr.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

const PRIVATE_RANGES = [
  'loopback',
  'private',
  'linkLocal',
  'uniqueLocal',
  'unspecified',
];

export const isPrivateIP = (ip) => {
  try {
    const parsed = ipaddr.process(ip);
    const range = parsed.range();
    return PRIVATE_RANGES.includes(range);
  } catch {
    return true;
  }
};

export const validateUrlHostname = (urlString) => {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Only HTTP and HTTPS protocols are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: 'This hostname is not allowed' };
  }

  try {
    const addr = ipaddr.process(hostname);
    if (PRIVATE_RANGES.includes(addr.range())) {
      return { safe: false, reason: 'Private or reserved IP addresses are not allowed' };
    }
  } catch {
    // not an IP literal — hostname will be checked at fetch time via DNS
  }

  return { safe: true };
};

export const resolveAndValidate = async (urlString) => {
  const parsed = new URL(urlString);
  const hostname = parsed.hostname;

  // If hostname is already an IP literal, validate directly
  try {
    const addr = ipaddr.process(hostname);
    if (PRIVATE_RANGES.includes(addr.range())) {
      return { safe: false, reason: 'Private or reserved IP addresses are not allowed' };
    }
    return { safe: true };
  } catch {
    // not an IP literal — resolve via DNS
  }

  // Resolve ALL addresses — a hostname with multiple A records
  // could have both public and private IPs. Block if ANY is private.
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return { safe: false, reason: `DNS resolution failed for ${hostname}` };
  }

  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      return { safe: false, reason: `Hostname resolves to a private IP (${address})` };
    }
  }

  return { safe: true };
};
