import { config } from '../core/config.js';
import { HttpError, httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

const API = 'https://api.github.com';

interface User {
  login: string;
  id: number;
  name?: string | null;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  email?: string | null;
  bio?: string | null;
  twitter_username?: string | null;
  public_repos: number;
  followers: number;
  created_at: string;
  html_url: string;
}

interface SearchUsers {
  total_count: number;
  items: { login: string }[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json' };
  // 60 req/hr anonymous vs 5000 with any token — worth setting even unscoped.
  if (config.githubToken) h.Authorization = `Bearer ${config.githubToken}`;
  return h;
}

function toFinding(u: User, now: string, confidence: number): Finding {
  const bits = [
    u.name && `Name: ${u.name}`,
    u.company && `Company: ${u.company}`,
    u.location && `Location: ${u.location}`,
    u.email && `Public email: ${u.email}`,
    u.blog && `Site: ${u.blog}`,
    u.twitter_username && `X/Twitter: @${u.twitter_username}`,
    u.bio && `Bio: ${u.bio.replace(/\s+/g, ' ').slice(0, 300)}`,
    `${u.public_repos} repos, ${u.followers} followers`,
    `Joined ${u.created_at.slice(0, 10)}`,
  ].filter(Boolean) as string[];

  return {
    source: 'github',
    label: 'GitHub',
    title: `@${u.login}`,
    detail: bits.join('\n'),
    url: u.html_url,
    retrievedAt: now,
    confidence,
    extra: { githubId: u.id, declaredEmail: u.email },
  };
}

export const githubSource: Source = {
  id: 'github',
  label: 'GitHub',
  accepts: ['username', 'email'],

  async run(subject, ctx) {
    const findings: Finding[] = [];

    if (subject.kind === 'username') {
      try {
        const u = await httpJson<User>(
          `${API}/users/${encodeURIComponent(subject.value.replace(/^@/, ''))}`,
          { headers: headers(), timeoutMs: 5000 },
        );
        findings.push(toFinding(u, ctx.now, 0.9));
      } catch (err) {
        // No GitHub account is a clean "nothing found", not a source failure.
        if (err instanceof HttpError && err.status === 404) return [];
        throw err;
      }
      return findings;
    }

    // Email path: GitHub indexes the email field for search, which resolves a
    // mailbox to a developer identity when the user made it public.
    const res = await httpJson<SearchUsers>(
      `${API}/search/users?q=${encodeURIComponent(subject.value)}+in:email&per_page=5`,
      { headers: headers(), timeoutMs: 6000 },
    );
    for (const item of res.items ?? []) {
      try {
        const u = await httpJson<User>(`${API}/users/${item.login}`, {
          headers: headers(),
          timeoutMs: 5000,
        });
        findings.push(toFinding(u, ctx.now, 0.7));
      } catch {
        // Skip users that vanish between search and fetch.
      }
    }
    return findings;
  },
};
