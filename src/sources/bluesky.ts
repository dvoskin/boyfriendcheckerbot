import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Bluesky's public AppView needs no auth and exposes the full public graph, which
 * makes it the richest free social source in the stack: profile, follower counts
 * and recent posts in two unauthenticated calls.
 */
const APPVIEW = 'https://public.api.bsky.app/xrpc';

interface Profile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  createdAt?: string;
  avatar?: string;
}

interface SearchResponse {
  actors: Profile[];
}

function toFinding(p: Profile, now: string, confidence: number): Finding {
  const bits = [
    p.displayName && `Name: ${p.displayName}`,
    p.description && `Bio: ${p.description.replace(/\s+/g, ' ').slice(0, 300)}`,
    p.followersCount !== undefined && `${p.followersCount} followers / ${p.followsCount ?? '?'} following`,
    p.postsCount !== undefined && `${p.postsCount} posts`,
    p.createdAt && `Joined ${p.createdAt.slice(0, 10)}`,
    `DID: ${p.did}`,
  ].filter(Boolean) as string[];

  return {
    source: 'bluesky',
    label: 'Bluesky',
    title: `@${p.handle}`,
    detail: bits.join('\n'),
    url: `https://bsky.app/profile/${p.handle}`,
    retrievedAt: now,
    confidence,
    extra: { did: p.did, avatar: p.avatar },
  };
}

export const blueskySource: Source = {
  id: 'bluesky',
  label: 'Bluesky',
  accepts: ['username', 'person', 'email'],

  async run(subject, ctx) {
    const findings: Finding[] = [];
    const term = subject.value.replace(/^@/, '');

    // Exact handle first — cheap and unambiguous when it hits.
    if (subject.kind === 'username') {
      for (const actor of [term, `${term}.bsky.social`]) {
        try {
          const p = await httpJson<Profile>(
            `${APPVIEW}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
            { timeoutMs: 5000 },
          );
          findings.push(toFinding(p, ctx.now, 0.9));
          break;
        } catch {
          // Not found under this form; fall through to the next candidate.
        }
      }
    }

    // Fuzzy actor search catches display-name matches the exact lookup misses —
    // but Bluesky returns anyone sharing ONE name word (a "George" search returns
    // George Takei, George Conway…). Require EVERY real name part to appear, so a
    // random famous namesake never lands in the report.
    if (findings.length === 0) {
      try {
        const res = await httpJson<SearchResponse>(
          `${APPVIEW}/app.bsky.actor.searchActors?q=${encodeURIComponent(term)}&limit=8`,
          { timeoutMs: 5000 },
        );
        const tokens = term.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
        for (const actor of res.actors ?? []) {
          const hay = `${actor.displayName ?? ''} ${actor.handle ?? ''}`.toLowerCase();
          if (tokens.length >= 2 && !tokens.every((t) => hay.includes(t))) continue;
          findings.push(toFinding(actor, ctx.now, 0.45));
        }
      } catch {
        // Search is best-effort; an empty result is a valid answer.
      }
    }

    return findings;
  },
};
