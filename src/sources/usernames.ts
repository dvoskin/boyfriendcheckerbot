import { probe } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

export interface Site {
  name: string;
  url: (u: string) => string;
  /** Body markers that mean "no such user" even though the status was 200. */
  absent?: string[];
  /**
   * Body markers that MUST be present for a real profile. Use for sites that
   * return 200 with a shell page for everything (soft-404) but embed a data
   * blob only for real users — TikTok's "userInfo" is the canonical case.
   * When set, a 200 without any of these markers counts as "not found".
   */
  present?: string[];
  /**
   * Sites that answer 200 for everything or sit behind a login wall. We still
   * report them, but at low confidence so the report does not state as fact
   * something that is really just "the URL resolved".
   */
  weak?: boolean;
  category: 'social' | 'dev' | 'creator' | 'commerce' | 'payment' | 'other';
}

/**
 * Hand-picked surfaces rather than an exhaustive list. Every entry here has been
 * chosen because a hit is *informative* for a US subject — payment handles,
 * booking links and shop fronts tie a pseudonym to real-world activity far more
 * often than yet another gaming forum does.
 *
 * To go wide later, Maigret covers 500+ sites; its site database is the natural
 * thing to import rather than growing this list by hand.
 */
const SITES: Site[] = [
  // Social. Note the omissions: Instagram, Reddit, Telegram and Pinterest are
  // deliberately NOT probed here. From a datacenter IP, unauthenticated, they
  // return an identical 200 shell for real and fake handles, so a blind URL
  // probe cannot tell them apart and would emit confident false positives.
  // They are instead covered by the search-API layer (site:reddit.com "handle")
  // and the Internet Archive, and can be added back later via their official
  // APIs or a residential proxy. Trust of the enumerator matters more than reach.
  { name: 'TikTok', url: (u) => `https://www.tiktok.com/@${u}`, present: ['"userInfo"', '"uniqueId"'], category: 'social' },
  { name: 'YouTube', url: (u) => `https://www.youtube.com/@${u}`, category: 'social' },
  { name: 'Snapchat', url: (u) => `https://www.snapchat.com/add/${u}`, category: 'social' },
  { name: 'Mastodon', url: (u) => `https://mastodon.social/@${u}`, category: 'social' },
  { name: 'Tumblr', url: (u) => `https://${u}.tumblr.com`, category: 'social' },
  { name: 'Quora', url: (u) => `https://www.quora.com/profile/${u}`, weak: true, category: 'social' },

  // Dev — high signal, often carries a real name and employer
  { name: 'GitHub', url: (u) => `https://github.com/${u}`, category: 'dev' },
  { name: 'GitLab', url: (u) => `https://gitlab.com/${u}`, category: 'dev' },
  { name: 'Bitbucket', url: (u) => `https://bitbucket.org/${u}/`, category: 'dev' },
  { name: 'dev.to', url: (u) => `https://dev.to/${u}`, category: 'dev' },
  { name: 'Hacker News', url: (u) => `https://news.ycombinator.com/user?id=${u}`, absent: ['No such user.'], category: 'dev' },
  { name: 'npm', url: (u) => `https://www.npmjs.com/~${u}`, category: 'dev' },
  { name: 'Docker Hub', url: (u) => `https://hub.docker.com/u/${u}`, category: 'dev' },
  { name: 'Replit', url: (u) => `https://replit.com/@${u}`, category: 'dev' },
  { name: 'CodePen', url: (u) => `https://codepen.io/${u}`, category: 'dev' },
  { name: 'Keybase', url: (u) => `https://keybase.io/${u}`, category: 'dev' },

  // Creator / publishing — bios here are usually written in the first person
  { name: 'Substack', url: (u) => `https://${u}.substack.com`, category: 'creator' },
  { name: 'Patreon', url: (u) => `https://www.patreon.com/${u}`, category: 'creator' },
  { name: 'SoundCloud', url: (u) => `https://soundcloud.com/${u}`, category: 'creator' },
  { name: 'Bandcamp', url: (u) => `https://${u}.bandcamp.com`, category: 'creator' },
  { name: 'Behance', url: (u) => `https://www.behance.net/${u}`, category: 'creator' },
  { name: 'Dribbble', url: (u) => `https://dribbble.com/${u}`, category: 'creator' },
  { name: 'Flickr', url: (u) => `https://www.flickr.com/people/${u}/`, category: 'creator' },
  { name: 'Vimeo', url: (u) => `https://vimeo.com/${u}`, category: 'creator' },
  { name: 'Letterboxd', url: (u) => `https://letterboxd.com/${u}/`, category: 'creator' },
  { name: 'Last.fm', url: (u) => `https://www.last.fm/user/${u}`, category: 'creator' },
  { name: 'WordPress', url: (u) => `https://${u}.wordpress.com`, category: 'creator' },

  // Commerce — a storefront means a business entity to chase in registries
  { name: 'Etsy', url: (u) => `https://www.etsy.com/shop/${u}`, category: 'commerce' },
  { name: 'Fiverr', url: (u) => `https://www.fiverr.com/${u}`, category: 'commerce' },
  { name: 'Gumroad', url: (u) => `https://${u}.gumroad.com`, category: 'commerce' },
  { name: 'Kickstarter', url: (u) => `https://www.kickstarter.com/profile/${u}`, category: 'commerce' },
  { name: 'Product Hunt', url: (u) => `https://www.producthunt.com/@${u}`, category: 'commerce' },

  // Payment and booking — the strongest pseudonym-to-person links in the list
  { name: 'Venmo', url: (u) => `https://account.venmo.com/u/${u}`, category: 'payment' },
  { name: 'Cash App', url: (u) => `https://cash.app/$${u}`, category: 'payment' },
  { name: 'PayPal.me', url: (u) => `https://www.paypal.me/${u}`, category: 'payment' },
  { name: 'Ko-fi', url: (u) => `https://ko-fi.com/${u}`, category: 'payment' },
  { name: 'Buy Me a Coffee', url: (u) => `https://buymeacoffee.com/${u}`, category: 'payment' },
  { name: 'Calendly', url: (u) => `https://calendly.com/${u}`, category: 'payment' },
  { name: 'Cal.com', url: (u) => `https://cal.com/${u}`, category: 'payment' },

  // Aggregators — a hit here often hands you every other account at once
  { name: 'Linktree', url: (u) => `https://linktr.ee/${u}`, category: 'other' },
  { name: 'about.me', url: (u) => `https://about.me/${u}`, category: 'other' },
  { name: 'Gravatar', url: (u) => `https://gravatar.com/${u}.json`, category: 'other' },
  { name: 'Discogs', url: (u) => `https://www.discogs.com/user/${u}`, category: 'other' },
  { name: 'Chess.com', url: (u) => `https://www.chess.com/member/${u}`, category: 'other' },

  // ── Expansion batch (calibrate.ts verified) ──────────────────────────────
  // Social & messaging
  { name: 'VSCO', url: (u) => `https://vsco.co/${u}/gallery`, category: 'social' },
  { name: 'Ello', url: (u) => `https://ello.co/${u}`, category: 'social' },
  { name: 'BiggerPockets', url: (u) => `https://www.biggerpockets.com/users/${u}`, category: 'social' },
  { name: 'Rumble', url: (u) => `https://rumble.com/user/${u}`, category: 'social' },
  // Dev & professional (real names, employers)
  { name: 'AngelList', url: (u) => `https://angel.co/u/${u}`, category: 'dev' },
  { name: 'Stack Overflow', url: (u) => `https://stackoverflow.com/users/${u}`, category: 'dev' },
  { name: 'Hashnode', url: (u) => `https://hashnode.com/@${u}`, absent: ['User not found'], category: 'dev' },
  { name: 'Wellfound', url: (u) => `https://wellfound.com/u/${u}`, category: 'dev' },
  // Creator / hobby (personality signal)
  { name: 'Steam', url: (u) => `https://steamcommunity.com/id/${u}`, absent: ['could not be found', 'Steam Community :: Error'], category: 'creator' },
  { name: 'Goodreads', url: (u) => `https://www.goodreads.com/${u}`, category: 'creator' },
  { name: 'Untappd', url: (u) => `https://untappd.com/user/${u}`, category: 'creator' },
  { name: 'Strava', url: (u) => `https://www.strava.com/athletes/${u}`, category: 'creator' },
  { name: 'AllTrails', url: (u) => `https://www.alltrails.com/members/${u}`, category: 'creator' },
  { name: 'Wattpad', url: (u) => `https://www.wattpad.com/user/${u}`, category: 'creator' },
  { name: 'DeviantArt', url: (u) => `https://www.deviantart.com/${u}`, category: 'creator' },
  { name: 'Giphy', url: (u) => `https://giphy.com/${u}`, category: 'creator' },
  { name: 'ProductHunt', url: (u) => `https://www.producthunt.com/@${u}`, category: 'creator' },
  // Commerce / payment / booking (ties pseudonym to real activity)
  { name: 'Depop', url: (u) => `https://www.depop.com/${u}/`, category: 'commerce' },
  { name: 'Poshmark', url: (u) => `https://poshmark.com/closet/${u}`, category: 'commerce' },
  { name: 'Cameo', url: (u) => `https://www.cameo.com/${u}`, category: 'commerce' },
  { name: 'Throne', url: (u) => `https://throne.com/${u}`, category: 'commerce' },
  { name: 'Wishlistr', url: (u) => `https://www.wishlistr.com/${u}`, category: 'other' },
];

/** Exposed so scripts/calibrate.ts can audit the table for soft-404 sites. */
export const SITES_FOR_CALIBRATION = SITES;

/** Cap on simultaneous sockets so 55 probes do not stall each other. */
const CONCURRENCY = 14;

async function checkSite(site: Site, username: string, now: string): Promise<Finding | null> {
  const url = site.url(username);
  const res = await probe(url);
  if (!res) return null;

  // 3xx away from the profile URL is the usual "not found" pattern on sites
  // that redirect misses to a landing or login page.
  if (res.status !== 200) return null;
  if (site.absent?.some((marker) => res.body.includes(marker))) return null;
  // Soft-404 guard: when a site only embeds a data blob for real profiles,
  // a 200 without that blob is a "not found" dressed up as success.
  if (site.present && !site.present.some((marker) => res.body.includes(marker))) return null;

  return {
    source: 'usernames',
    label: site.name,
    title: `${site.name}: @${username}`,
    detail: site.weak
      ? 'URL resolves, but this site answers 200 broadly — verify manually'
      : undefined,
    url,
    retrievedAt: now,
    confidence: site.weak ? 0.35 : 0.8,
    extra: { category: site.category },
  };
}

export const usernameSource: Source = {
  id: 'usernames',
  label: 'Social surfaces',
  accepts: ['username'],

  async run(subject, ctx) {
    const username = subject.value.replace(/^@/, '');
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(username)) {
      throw new Error(`"${username}" is not a plausible handle`);
    }

    const found: Finding[] = [];
    const queue = [...SITES];

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const site = queue.shift();
        if (!site) return;
        const hit = await checkSite(site, username, ctx.now);
        if (hit) found.push(hit);
      }
    });

    await Promise.all(workers);

    found.sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));
    return found;
  },
};
