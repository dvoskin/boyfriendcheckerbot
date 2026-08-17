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
  'awsdns.org',
  'awsdns.net',
  'awsdns.co.uk',
  'bandwidth.com',
]);

/**
 * Email providers. The domain after the @ in an email is the mail host, never
 * "his website" — extracting it produced nonsense like "his website: yahoo.com".
 */
const EMAIL_PROVIDERS = new Set([
  'gmail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'rcn.com',
  'charter.net',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'cox.net',
  'earthlink.net',
  'optonline.net',
  'bellsouth.net',
  'roadrunner.com',
]);

/**
 * Bare public suffixes. Reducing "sub.example.co.uk" to a naive last-two labels
 * yields "co.uk", which is not a registrable domain — reject these outright.
 */
const PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'com.br',
  'co.in',
  'com.mx',
]);

/**
 * Real TLDs we accept as a domain's ending. Without this, a username with a dot
 * ("puz.inski") looks domain-shaped and gets emitted as "his website". Covers the
 * gTLDs and ccTLDs a personal site realistically uses; anything else is not a
 * domain.
 */
const VALID_TLDS = new Set([
  'com','net','org','io','co','app','dev','me','xyz','ai','us','info','biz','tv','gg','so','sh',
  'to','ly','be','pro','online','site','store','blog','tech','design','studio','agency','life',
  'world','live','news','media','group','club','fm','cc','wtf','lol','fyi','link','page','wiki',
  'space','vip','fun','shop','art','email','photo','photography','me','cloud','digital','network',
  'uk','ca','au','de','fr','es','it','nl','ru','jp','cn','in','br','mx','nz','ie','se','no','fi',
  'dk','pl','pt','ch','at','cz','gr','il','za','kr','tr','ua','ro','hu','sg','hk',
]);

const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
const HANDLE_RE = /(?:^|[\s(])@([a-z0-9._-]{2,40})\b/gi;

/**
 * Social profile URLs → the username inside them. This is what turns a NAME
 * search into an account search: a web result links to instagram.com/danny_vosk,
 * we pull "danny_vosk", and the username enumerator then finds his accounts
 * everywhere else. Handles the per-platform path shapes.
 */
// The (?<!\w) anchors the host so "x.com" doesn't match the tail of "vox.com".
const SOCIAL_URL_RES: RegExp[] = [
  /(?<!\w)(?:instagram\.com|facebook\.com|twitter\.com|x\.com|github\.com|pinterest\.com)\/([a-z0-9._-]{2,40})(?:[/?#]|$)/gi,
  /(?<!\w)(?:tiktok\.com|threads\.net)\/@([a-z0-9._-]{2,40})(?:[/?#]|$)/gi,
  /(?<!\w)(?:t\.me|telegram\.me)\/([a-z0-9._-]{2,40})(?:[/?#]|$)/gi,
];

/** URL path segments that are pages, not usernames — never pivot on these. */
const NOT_A_HANDLE = new Set([
  'p',
  'reel',
  'reels',
  'explore',
  'stories',
  'about',
  'help',
  'login',
  'share',
  'watch',
  'events',
  'groups',
  'pages',
  'hashtag',
  'search',
  'home',
  'i',
  'photo',
  'photos',
  'media',
]);

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
  // For ccTLDs like janedoe.co.uk, the registrable domain is the last THREE
  // labels, not two — otherwise every .co.uk / .com.au domain gets dropped.
  const base = PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3 ? lastThree : lastTwo;
  if (PLATFORM_HOSTS.has(base) || PLATFORM_HOSTS.has(host)) return null;
  if (INFRA_HOSTS.has(base) || INFRA_HOSTS.has(host)) return null;
  if (EMAIL_PROVIDERS.has(base) || EMAIL_PROVIDERS.has(host)) return null;
  // Still a bare public suffix (only two labels, e.g. "co.uk") — no real name.
  if (PUBLIC_SUFFIXES.has(base)) return null;
  // Reject anything whose ending isn't a real TLD (e.g. "puz.inski" is a handle).
  const tld = base.split('.').pop()!;
  if (!VALID_TLDS.has(tld)) return null;
  return base;
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

  // Social profile URLs (usually the finding's own link) → username to enumerate.
  const urlText = `${finding.url ?? ''}\n${haystack}`;
  for (const re of SOCIAL_URL_RES) {
    for (const m of urlText.matchAll(re)) {
      const handle = m[1]!.toLowerCase();
      if (NOT_A_HANDLE.has(handle) || /^\d+$/.test(handle)) continue;
      const key = `username:${handle}`;
      if (!out.has(key)) out.set(key, { kind: 'username', value: handle, reason: `social handle from ${finding.label}` });
    }
  }

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

  // Strip emails first: the domain half of an email is the mail provider, not a
  // personal website, so it must not be matched as a domain pivot.
  const domainHaystack = haystack.replace(EMAIL_RE, ' ');
  for (const m of domainHaystack.matchAll(DOMAIN_RE)) {
    const base = registrableHost(m[1]!);
    if (!base) continue;
    const key = `domain:${base}`;
    if (!out.has(key)) out.set(key, { kind: 'domain', value: base, reason: `personal domain from ${finding.label}` });
  }

  out.delete(originKey);
  return [...out.values()];
}
