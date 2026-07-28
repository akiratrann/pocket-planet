// Which IP addresses this server is willing to dial on a caller's behalf, and
// how to dial one without letting DNS change its mind halfway.
//
// Lives in its own module because two places have to agree on the answer: the
// route that VETS an ingest URL (server/index.ts) and the fetcher that actually
// OPENS the connection (server/pipeline/ingest.ts). If those two ever disagreed,
// the vetting would be decorative.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { BlockList, isIP } from 'node:net';

/**
 * Addresses reachable only from inside the deployment. 169.254.169.254 is the
 * cloud metadata service and hands out instance credentials, which is why
 * link-local matters as much as loopback here.
 */
const BLOCKED_NETS = new BlockList();
// IPv4
BLOCKED_NETS.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
BLOCKED_NETS.addSubnet('10.0.0.0', 8, 'ipv4'); // private
BLOCKED_NETS.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT
BLOCKED_NETS.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
BLOCKED_NETS.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local + cloud metadata
BLOCKED_NETS.addSubnet('172.16.0.0', 12, 'ipv4'); // private
BLOCKED_NETS.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
BLOCKED_NETS.addSubnet('192.168.0.0', 16, 'ipv4'); // private
BLOCKED_NETS.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
BLOCKED_NETS.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
BLOCKED_NETS.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved + 255.255.255.255
// IPv6
BLOCKED_NETS.addAddress('::', 'ipv6'); // unspecified
BLOCKED_NETS.addAddress('::1', 'ipv6'); // loopback
BLOCKED_NETS.addSubnet('fc00::', 7, 'ipv6'); // unique-local
BLOCKED_NETS.addSubnet('fe80::', 10, 'ipv6'); // link-local
BLOCKED_NETS.addSubnet('ff00::', 8, 'ipv6'); // multicast

export const URL_REFUSED =
  'That URL is not allowed. Only public http(s) addresses can be studied.';

export const INGEST_UA = 'PocketPlanet/1.0 (travel guide ingestion)';

/** True when this address must never be dialled on a caller's behalf. */
export function isBlockedAddress(raw: string): boolean {
  const ip = raw.replace(/^\[/, '').replace(/\]$/, '').split('%')[0]; // brackets + zone id
  const family = isIP(ip);
  if (family === 4) return BLOCKED_NETS.check(ip, 'ipv4');
  if (family === 6) {
    // ::ffff:127.0.0.1 dials the IPv4 loopback, so judge the embedded address.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped && isIP(mapped[1]) === 4) return BLOCKED_NETS.check(mapped[1], 'ipv4');
    return BLOCKED_NETS.check(ip, 'ipv6');
  }
  return true; // not an address we can reason about → refuse
}

interface LookupEntry {
  address: string;
  family: number;
}

export interface PinnedResponse {
  status: number;
  /** `Location` header, only when the status is a redirect. */
  location: string | null;
  /** Response body, empty unless `readBody` was asked for. */
  body: string;
}

export interface PinnedOptions {
  /** Read and return the body. When false the socket is dropped after headers. */
  readBody?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Fetch a URL over a connection PINNED to an address that was already vetted.
 *
 * This is the piece that makes the vetting mean something. `vetUrl` resolves the
 * hostname and checks every answer, but a plain `fetch()` afterwards resolves it
 * *again* — and a record that returns a public address to the first lookup and a
 * private one to the second is classic DNS rebinding. Nothing in a vetted URL
 * string carries the decision forward, so the address has to travel with it.
 *
 * `address` is dialled directly; the hostname is still used for TLS SNI, the
 * certificate check and the Host header, so pinning does not weaken any of them.
 * The address is re-checked here, and again once the socket is up: this function
 * has to be safe on its own terms, not merely because its caller was careful.
 *
 * Redirects are never followed — the caller vets each hop and re-enters here.
 */
export function pinnedRequest(
  url: string,
  address: string,
  opts: PinnedOptions = {},
): Promise<PinnedResponse> {
  const { readBody = false, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('That is not a valid URL.'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(URL_REFUSED));
      return;
    }
    if (!isIP(address) || isBlockedAddress(address)) {
      reject(new Error(URL_REFUSED));
      return;
    }

    const hostname = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const doRequest = u.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = (value: PinnedResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = doRequest(
      {
        protocol: u.protocol,
        hostname,
        port: u.port || (u.protocol === 'https:' ? '443' : '80'),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { 'User-Agent': INGEST_UA, Accept: 'text/html,text/plain,*/*' },
        // Node resolves through this hook, so handing back the vetted address is
        // what actually pins the socket — the system resolver is never consulted.
        // Node's happy-eyeballs connect path asks with `{ all: true }` and wants
        // an array back; the single-address form is a bare string. Answer in
        // whichever shape was asked for, or the socket rejects it outright.
        lookup: (
          _host: string,
          options: { all?: boolean } | undefined,
          cb: (err: Error | null, addr: string | LookupEntry[], family?: number) => void,
        ) => {
          const family = isIP(address) === 6 ? 6 : 4;
          if (options?.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        },
        // TLS is still validated against the real hostname, not the address.
        servername: u.protocol === 'https:' && !isIP(hostname) ? hostname : undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const isRedirect = status >= 300 && status < 400;
        const location = isRedirect ? (res.headers.location ?? null) : null;

        if (!readBody || isRedirect) {
          res.resume(); // drop the body; we only wanted the status line
          done({ status, location, body: '' });
          return;
        }

        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            fail(new Error('That page is too large to study.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => done({ status, location, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', fail);
      },
    );

    // Last line of defence: whatever the socket actually connected to has to
    // pass the same test, even if the lookup hook were somehow bypassed.
    req.on('socket', (socket) => {
      const check = () => {
        const peer = socket.remoteAddress;
        if (peer && isBlockedAddress(peer)) req.destroy(new Error(URL_REFUSED));
      };
      if (socket.remoteAddress) check();
      else socket.once('connect', check);
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timed out fetching that page.')));
    req.on('error', fail);
    req.end();
  });
}
