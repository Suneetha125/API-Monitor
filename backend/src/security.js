import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.status = 400;
  }
}

function isPublicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.parse(address).range() === 'unicast';
}

export async function validateEndpointInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('A JSON object is required.');
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const urlText = typeof input.url === 'string' ? input.url.trim() : '';
  if (!name || name.length > 80) throw new InputError('Name must be between 1 and 80 characters.');
  if (!urlText || urlText.length > 2048) throw new InputError('A valid URL is required.');

  if (input.simulation !== undefined && input.simulation !== null) {
    if (typeof input.simulation !== 'string' || !['normal', 'slow', 'timeout', 'error'].includes(input.simulation)) {
      throw new InputError('Choose a supported simulation.');
    }
    if (urlText !== `simulation://${input.simulation}`) {
      throw new InputError('Simulation URLs must match their selected simulation.');
    }
    return { name, url: urlText, simulation: input.simulation };
  }

  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new InputError('A valid HTTP or HTTPS URL is required.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new InputError('Only HTTP and HTTPS URLs are supported.');
  }
  if (url.username || url.password) throw new InputError('URLs must not contain credentials.');
  if (url.search) throw new InputError('Query-string credentials and parameters are not supported.');
  if (url.hash) throw new InputError('URL fragments are not supported.');
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw new InputError('URL port is invalid.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.endsWith('.') || hostname.toLowerCase() === 'localhost') {
    throw new InputError('Local and internal network addresses are not allowed.');
  }

  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new InputError('Local and internal network addresses are not allowed.');
    }
  } else {
    let addresses;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new InputError('The URL hostname could not be resolved.');
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new InputError('The URL must resolve only to public IP addresses.');
    }
  }

  return { name, url: url.toString(), simulation: null };
}
