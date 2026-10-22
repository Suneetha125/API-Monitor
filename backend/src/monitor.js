import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';
import { InputError } from './security.js';

const TIMEOUT_MS = 2000;
const SIMULATIONS = new Set(['normal', 'slow', 'timeout', 'error']);

function lookupPinned(address) {
  return (hostname, options, callback) => {
    const family = isIP(address);
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function isPublicAddress(address) {
  return ipaddr.isValid(address) && ipaddr.parse(address).range() === 'unicast';
}

async function request(urlText, pinnedAddress, started) {
  const url = new URL(urlText);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Math.round(performance.now() - started) });
    };
    const req = transport.request(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'PulseCheck/1.0' },
      lookup: pinnedAddress ? lookupPinned(pinnedAddress) : undefined
    }, (response) => {
      response.resume();
      response.on('end', () => {
        const statusCode = response.statusCode ?? null;
        finish({
          statusCode,
          success: statusCode >= 200 && statusCode < 300,
          error: statusCode >= 200 && statusCode < 300 ? null : `HTTP ${statusCode}`
        });
      });
      response.on('aborted', () => finish({
        statusCode: null,
        success: false,
        error: 'Network error: response ended unexpectedly'
      }));
      response.on('error', (error) => finish({
        statusCode: null,
        success: false,
        error: `Network error: ${error.message}`
      }));
    });
    timer = setTimeout(() => {
      const error = new Error('Request timed out');
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    }, TIMEOUT_MS);
    req.on('error', (error) => {
      finish({
        statusCode: null,
        success: false,
        error: error.code === 'ETIMEDOUT' ? 'Request timed out' : `Network error: ${error.message}`
      });
    });
    req.end();
  });
}

export async function runHealthCheck(endpoint, serverPort) {
  const started = performance.now();
  let targetUrl = endpoint.url;
  let pinnedAddress;
  if (endpoint.simulation) {
    if (!SIMULATIONS.has(endpoint.simulation)) throw new InputError('Unsupported simulation.');
    targetUrl = `http://127.0.0.1:${serverPort}/api/simulations/${endpoint.simulation}`;
  } else {
    const url = new URL(endpoint.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try {
      addresses = isIP(hostname)
        ? [{ address: hostname }]
        : await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      return { statusCode: null, durationMs: Math.round(performance.now() - started), success: false, error: 'Network error: hostname could not be resolved' };
    }
    if (addresses.length === 0 || addresses.some(({ address }) =>
      !ipaddr.isValid(address) || ipaddr.parse(address).range() !== 'unicast'
    )) {
      return { statusCode: null, durationMs: Math.round(performance.now() - started), success: false, error: 'Network error: target resolves to a non-public address' };
    }
    pinnedAddress = addresses[0].address;
  }
  return request(targetUrl, pinnedAddress, started);
}
