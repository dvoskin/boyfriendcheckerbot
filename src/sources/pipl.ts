import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Pipl — deep identity resolution. Give it an email or a name and it ties the
 * person to their social accounts, other emails, phone numbers, usernames and
 * jobs. Complements Enformion (which is records-first) with a contact/social-first
 * view. Pluggable: skipped unless a Pipl key is set.
 */
const API = 'https://api.pipl.com/search/';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const piplSource: Source = {
  id: 'pipl',
  label: 'Identity (Pipl)',
  accepts: ['email', 'person', 'username'],

  async run(subject, ctx) {
    if (!config.piplKey) return null;

    const params = new URLSearchParams({ key: config.piplKey });
    if (subject.kind === 'email') params.set('email', subject.value);
    else if (subject.kind === 'username') params.set('username', subject.value.replace(/^@/, ''));
    else {
      const parts = subject.value.trim().split(/\s+/);
      if (parts.length < 2) return null;
      params.set('first_name', parts[0]!);
      params.set('last_name', parts[parts.length - 1]!);
    }

    const data = await httpJson<any>(`${API}?${params}`, { timeoutMs: 12_000, cacheTtl: 86_400 });
    const person = data.person ?? data.possible_persons?.[0];
    if (!person) return [];

    const grab = (arr: any[] | undefined, f: (x: any) => string | undefined) =>
      [...new Set((arr ?? []).map(f).filter(Boolean))] as string[];

    const names = grab(person.names, (n) => n.display);
    const emails = grab(person.emails, (e) => e.address);
    const phones = grab(person.phones, (p) => p.display_international ?? p.number);
    const usernames = grab(person.usernames, (u) => u.content);
    const jobs = grab(person.jobs, (j) => [j.title, j.organization].filter(Boolean).join(' @ '));
    const urls = grab(person.user_ids ?? person.urls, (u) => u.url ?? u.content);

    const findings: Finding[] = [];
    const detail = [
      names.length > 1 && `Names: ${names.slice(0, 4).join(', ')}`,
      jobs.length && `Work: ${jobs.slice(0, 2).join('; ')}`,
      emails.length && `Emails: ${emails.slice(0, 4).join(', ')}`,
      phones.length && `Phones: ${phones.slice(0, 4).join(', ')}`,
      usernames.length && `Usernames: ${usernames.slice(0, 6).join(', ')}`,
    ]
      .filter(Boolean)
      .join('\n');

    if (detail) {
      findings.push({
        source: 'pipl',
        label: 'Identity',
        title: `🪪 Identity match${names[0] ? `: ${names[0]}` : ''}`,
        detail,
        retrievedAt: ctx.now,
        confidence: 0.6,
      });
    }
    for (const u of urls.slice(0, 6)) {
      findings.push({ source: 'pipl', label: 'Profile', title: u.slice(0, 100), url: u.startsWith('http') ? u : undefined, retrievedAt: ctx.now, confidence: 0.45 });
    }
    return findings;
  },
};
