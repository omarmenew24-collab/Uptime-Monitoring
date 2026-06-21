import { lookup } from 'dns/promises';
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

  try {
    const addr = ipaddr.process(hostname);
    if (PRIVATE_RANGES.includes(addr.range())) {
      return { safe: false, reason: 'Private or reserved IP addresses are not allowed' };
    }
    return { safe: true, ip: hostname };
  } catch {
    // not an IP literal — resolve via DNS
  }

  try {
    const { address } = await lookup(hostname);
    if (isPrivateIP(address)) {
      return { safe: false, reason: `Hostname resolves to a private IP (${address})` };
    }
    return { safe: true, ip: address };
  } catch {
    return { safe: false, reason: `DNS resolution failed for ${hostname}` };
  }
};
