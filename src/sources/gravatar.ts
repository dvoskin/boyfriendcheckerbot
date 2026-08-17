import { createHash } from 'node:crypto';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Gravatar by email. Gravatar keys profiles off the MD5 of the email address, so
 * from just his email we can pull a public profile he may have forgotten exists:
 * display name, bio, location, and — most usefully — the other accounts he linked
 * to it (Twitter, GitHub, personal sites). Free, no key.
 */
interface GravAccount {
  domain?: string;
  display?: string;
  url?: string;
  shortname?: string;
}
interface GravProfile {
  displayName?: string;
  aboutMe?: string;
  currentLocation?: string;
  profileUrl?: string;
  accounts?: GravAccount[];
  urls?: { title?: string; value?: string }[];
}
interface GravResponse {
  entry?: GravProfile[];
}

export const gravatarSource: Source = {
  id: 'gravatar',
  label: 'Gravatar',
  accepts: ['email'],

  async run(subject, ctx) {
    const hash = createHash('md5').update(subject.value.trim().toLowerCase()).digest('hex');

    let data: GravResponse;
    try {
      data = await httpJson<GravResponse>(`https://gravatar.com/${hash}.json`, {
        timeoutMs: 6000,
        cacheTtl: 86_400,
        headers: { 'user-agent': 'recon-bot' },
        allowStatus: [404],
      });
    } catch {
      return []; // 404 / no profile is a normal, non-error answer
    }

    const p = data.entry?.[0];
    if (!p) return [];

    const linked = [
      ...(p.accounts ?? []).map((a) => `${a.shortname ?? a.domain}: ${a.url ?? a.display}`),
      ...(p.urls ?? []).map((u) => `${u.title ?? 'Link'}: ${u.value}`),
    ].filter(Boolean);

    return [
      {
        source: 'gravatar',
        label: 'Gravatar',
        title: `🪪 Gravatar profile${p.displayName ? `: ${p.displayName}` : ''}`,
        detail: [
          p.aboutMe && `Bio: ${p.aboutMe.replace(/\s+/g, ' ').slice(0, 200)}`,
          p.currentLocation && `Location: ${p.currentLocation}`,
          linked.length && `Linked accounts:\n${linked.slice(0, 8).join('\n')}`,
        ]
          .filter(Boolean)
          .join('\n'),
        url: p.profileUrl,
        retrievedAt: ctx.now,
        confidence: 0.7,
      },
    ];
  },
};
