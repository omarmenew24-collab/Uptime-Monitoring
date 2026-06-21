import { lookup } from 'dns/promises';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

const isPrivateIPv4 = (ip) => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;

  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 127.0.0.0/8 (loopback)
  if (parts[0] === 127) return true;
  // 169.254.0.0/16 (link-local, AWS/cloud metadata)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0
  if (parts.every((p) => p === 0)) return true;

  return false;
};

const isPrivateIPv6 = (ip) => {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  return false;
};

export const isPrivateIP = (ip) => {
  return isPrivateIPv4(ip) || isPrivateIPv6(ip);
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

  // Block raw IP addresses at input time
  if (isPrivateIPv4(hostname) || isPrivateIPv6(hostname)) {
    return { safe: false, reason: 'Private or reserved IP addresses are not allowed' };
  }

  return { safe: true };
};

export const resolveAndValidate = async (urlString) => {
  const parsed = new URL(urlString);
  const hostname = parsed.hostname;

  // If hostname is already an IP, check it directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { safe: false, reason: 'Private or reserved IP addresses are not allowed' };
    }
    return { safe: true, ip: hostname };
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
