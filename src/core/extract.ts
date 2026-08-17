import type { Finding, Subject, SubjectKind } from './types.js';

/** A new selector discovered inside a finding, ready to be looked up in turn. */
export interface Pivot {
  kind: SubjectKind;
  value: string;
  /** Why we believe this selector belongs to the same entity. */
  reason: string;
}

/**
 * Platform hosts that appear in every profile URL. Pivoting to them as "domains"
 * would send the graph chasing github.com itself instead of the subject, so they
 * are never emitted as domain pivots. A personal domain (janedoe.com) is exactly
 * what we DO want, which is why this is a stoplist rather than an allowlist.
 */
const PLATFORM_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'linkedin.com',
  'reddit.com',
  'youtube.com',
  'medium.com',
  'substack.com',
  't.me',
  'telegram.me',
  'bsky.app',
  'bsky.social',
  'mastodon.social',
  'keybase.io',
  'gravatar.com',
  'wordpress.com',
  'tumblr.com',
  'pinterest.com',
  'soundcloud.com',
  'bandcamp.com',
  'patreon.com',
  'venmo.com',
  'cash.app',
  'paypal.me',
  'ko-fi.com',
  'calendly.com',
  'cal.com',
  'linktr.ee',
  'about.me',
  'archive.org',
  'web.archive.org',
  'discogs.com',
  'chess.com',
  'npmjs.com',
  'pypi.org',
  'etsy.com',
  'ebay.com',
  'fiverr.com',
  'behance.net',
  'dribbble.com',
  'flickr.com',
  'vimeo.com',
  'last.fm',
  'google.com',
  'sec.gov',
  'courtlistener.com',
  'treasury.gov',
  'cms.hhs.gov',
]);

/**
 * Registrar, DNS, hosting and CDN infrastructure that shows up in RDAP and
 * certificate records. These belong to service providers, not the subject, so
 * pivoting to them sends the graph chasing Namecheap instead of the person.
 */
const INFRA_HOSTS = new Set([
  'registrar-servers.com',
  'domaincontrol.com',
  'namecheap.com',
  'godaddy.com',
  'cloudflare.com',
  'cloudflare.net',
  'nsone.net',
  'akamai.net',
  'akamaiedge.net',
  'awsdns.com',
  'amazonaws.com',
  'azure.com',
  'googledomains.com',
  'google.com',
  'gandi.net',
  'ovh.net',
  'digitalocean.com',
  'wixdns.net',
  'squarespace.com',
  'shopify.com',
  'fastly.net',
  'sucuri.net',
  'dnsmadeeasy.com',
  'ns.cloudflare.com',
  'letsencrypt.org',
  'sectigo.com',
  'digicert.com',
]);

const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
const HANDLE_RE = /(?:^|[\s(])@([a-z0-9._-]{2,40})\b/gi;

function registrableHost(raw: string): string | null {
  const host = raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!
    .split('?')[0]!;
  if (!host.includes('.')) return null;
  // Reduce sub.host.co.uk-style values to their registrable base by comparing
  // against the platform stoplist on the last two and three labels.
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const lastThree = labels.slice(-3).join('.');
  if (PLATFORM_HOSTS.has(lastTwo) || PLATFORM_HOSTS.has(lastThree) || PLATFORM_HOSTS.has(host)) {
    return null;
  }
  if (INFRA_HOSTS.has(lastTwo) || INFRA_HOSTS.has(lastThree) || INFRA_HOSTS.has(host)) {
    return null;
  }
  return lastTwo;
}

/** Pull well-known structured fields out of a finding's `extra` bag. */
function fromExtra(finding: Finding, out: Map<string, Pivot>): void {
  const extra = finding.extra ?? {};
  const add = (kind: SubjectKind, value: string | undefined, reason: string) => {
    if (!value) return;
    const key = `${kind}:${value.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { kind, value, reason });
  };

  if (typeof extra.declaredEmail === 'string') add('email', extra.declaredEmail, `${finding.label} public email`);
  if (typeof extra.twitter === 'string') add('username', extra.twitter, `${finding.label} linked X/Twitter`);
}

/**
 * Extract every new selector implied by a finding. Structured `extra` fields are
 * trusted most; free-text regex catches the rest. The origin selector is passed
 * so we never pivot straight back to what we already searched.
 */
export function extractPivots(finding: Finding, origin: Subject): Pivot[] {
  const out = new Map<string, Pivot>();
  const originKey = `${origin.kind}:${origin.value.toLowerCase()}`;

  fromExtra(finding, out);

  const haystack = [finding.title, finding.detail ?? ''].join('\n');

  for (const m of haystack.matchAll(EMAIL_RE)) {
    const value = m[0].toLowerCase();
    const key = `email:${value}`;
    if (!out.has(key)) out.set(key, { kind: 'email', value, reason: `mentioned in ${finding.label}` });
    // The local-part of a personal email is a strong username candidate.
    const local = value.split('@')[0]!;
    if (/^[a-z0-9._-]{3,}$/.test(local) && !/^(info|contact|hello|admin|support|sales|team|noreply)$/.test(local)) {
      const uKey = `username:${local}`;
      if (!out.has(uKey)) out.set(uKey, { kind: 'username', value: local, reason: `email local-part from ${finding.label}` });
    }
  }

  for (const m of haystack.matchAll(HANDLE_RE)) {
    const value = m[1]!.toLowerCase();
    const key = `username:${value}`;
    if (!out.has(key)) out.set(key, { kind: 'username', value, reason: `handle in ${finding.label}` });
  }

  for (const m of haystack.matchAll(DOMAIN_RE)) {
    const base = registrableHost(m[1]!);
    if (!base) continue;
    const key = `domain:${base}`;
    if (!out.has(key)) out.set(key, { kind: 'domain', value: base, reason: `personal domain from ${finding.label}` });
  }

  out.delete(originKey);
  return [...out.values()];
}
