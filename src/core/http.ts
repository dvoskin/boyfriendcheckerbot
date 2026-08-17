import { USER_AGENT } from './config.js';
import { cache } from './cache.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

interface GetOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Cache TTL in seconds. 0 disables caching for this call. */
  cacheTtl?: number;
  retries?: number;
  /** Treat these statuses as a valid answer rather than an error. */
  allowStatus?: number[];
}

const DEFAULT_TIMEOUT = 8000;

/**
 * Single choke point for outbound HTTP so that every source inherits the same
 * timeout, retry and cache behaviour. Several of our sources (archive.org CDX,
 * crt.sh) throttle hard and flap 429/503 under load, so backoff is mandatory
 * rather than nice to have.
 */
export async function httpGet(
  url: string,
  opts: GetOptions = {},
): Promise<{ status: number; body: string }> {
  const ttl = opts.cacheTtl ?? 3600;
  const key = `GET:${url}`;

  if (ttl > 0) {
    const hit = cache.get<{ status: number; body: string }>(key);
    if (hit) return hit;
  }

  const retries = opts.retries ?? 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 400ms, 1200ms, 3600ms — enough to clear a short throttle window
      // without blowing the caller's overall deadline.
      await sleep(400 * 3 ** (attempt - 1));
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
        redirect: 'follow',
      });

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        lastErr = new HttpError(res.status, url);
        continue;
      }

      const allowed = opts.allowStatus ?? [];
      if (!res.ok && !allowed.includes(res.status)) {
        throw new HttpError(res.status, url);
      }

      const out = { status: res.status, body: await res.text() };
      if (ttl > 0) cache.set(key, out, ttl);
      return out;
    } catch (err) {
      lastErr = err;
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      if (!isTimeout && err instanceof HttpError && err.status < 500 && err.status !== 429) {
        throw err;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Request failed: ${url}`);
}

export async function httpJson<T>(url: string, opts: GetOptions = {}): Promise<T> {
  const { body } = await httpGet(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  return JSON.parse(body) as T;
}

/**
 * Existence probe used by the username enumerator. Returns the status only and
 * never throws, because a 404 is a meaningful answer here, not a failure.
 */
export async function probe(
  url: string,
  timeoutMs = 6000,
): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        // Sites gate on a browser-shaped UA; a bot UA gets a soft block that
        // reads as "profile does not exist" and silently poisons results.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const body = res.status === 200 ? (await res.text()).slice(0, 20_000) : '';
    return { status: res.status, body };
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
