import { tryCharge } from '../core/budget.js';
import { config } from '../core/config.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Bright Data — reads his PUBLIC Instagram & TikTok profiles. This is the legal
 * way to see his real social life (bio, follower/following/post counts, display
 * name): Bright Data won Meta v. Bright Data over exactly this — logged-OUT
 * public data. We fetch the profile page through their Web Unlocker (which
 * bypasses the bot-blocking) and read the counts from the page's og:description
 * meta tag, which both platforms populate reliably.
 *
 * Pluggable: skipped unless a Bright Data key is set. Only reads PUBLIC data —
 * never logs in, never touches private posts/followers/DMs.
 */
const UNLOCKER = 'https://api.brightdata.com/request';

/** Pull a meta tag's content by property/name, case-insensitively. */
function meta(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = re.exec(html);
  if (m?.[1]) return m[1];
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, 'i');
  return re2.exec(html)?.[1];
}

async function fetchViaUnlocker(url: string): Promise<string | null> {
  try {
    const res = await fetch(UNLOCKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.brightDataKey}` },
      body: JSON.stringify({ zone: config.brightDataZone, url, format: 'raw' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

interface Platform {
  name: string;
  url: (u: string) => string;
  parse: (html: string, u: string) => Finding | null;
}

function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
}

const PLATFORMS: Platform[] = [
  {
    name: 'Instagram',
    url: (u) => `https://www.instagram.com/${u}/`,
    parse: (html, u) => {
      // og:description looks like: "1,234 Followers, 567 Following, 89 Posts - Name (@handle) on Instagram: ..."
      const desc = meta(html, 'og:description');
      const title = meta(html, 'og:title');
      if (!desc && !title) return null;
      return {
        source: 'brightdata',
        label: 'Instagram',
        title: `📸 Instagram @${u}`,
        detail: [title && decode(title), desc && decode(desc)].filter(Boolean).join('\n').slice(0, 400),
        url: `https://www.instagram.com/${u}/`,
        retrievedAt: '',
        confidence: 0.75,
      };
    },
  },
  {
    name: 'TikTok',
    url: (u) => `https://www.tiktok.com/@${u}`,
    parse: (html, u) => {
      const desc = meta(html, 'og:description');
      const title = meta(html, 'og:title');
      if (!desc && !title) return null;
      return {
        source: 'brightdata',
        label: 'TikTok',
        title: `🎵 TikTok @${u}`,
        detail: [title && decode(title), desc && decode(desc)].filter(Boolean).join('\n').slice(0, 400),
        url: `https://www.tiktok.com/@${u}`,
        retrievedAt: '',
        confidence: 0.75,
      };
    },
  },
];

export const brightDataSource: Source = {
  id: 'brightdata',
  label: 'Instagram / TikTok',
  accepts: ['username'],

  async run(subject, ctx) {
    if (!config.brightDataKey) return null;
    const u = subject.value.replace(/^@/, '');
    if (!/^[a-zA-Z0-9._]{2,30}$/.test(u)) return null;
    if (!(await tryCharge('brightdata'))) return null; // daily budget reached

    const results = await Promise.all(
      PLATFORMS.map(async (p) => {
        const html = await fetchViaUnlocker(p.url(u));
        if (!html) return null;
        // "Page not found" / login walls won't carry a real profile og:title.
        if (/Page Not Found|Sorry, this page/i.test(html)) return null;
        const f = p.parse(html, u);
        if (f) f.retrievedAt = ctx.now;
        return f;
      }),
    );

    return results.filter(Boolean) as Finding[];
  },
};
