import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * EmailRep.io — reputation and "realness" of an email. Answers the catfish
 * question: is this a throwaway/suspicious address, how long has it existed, was
 * it in breaches, and — very usefully — which social sites it's registered on.
 * Free (a key just lifts the rate limit).
 */
interface EmailRepResponse {
  email?: string;
  reputation?: string; // high | medium | low | none
  suspicious?: boolean;
  references?: number;
  details?: {
    blacklisted?: boolean;
    malicious_activity?: boolean;
    credentials_leaked?: boolean;
    data_breach?: boolean;
    first_seen?: string;
    last_seen?: string;
    domain_exists?: boolean;
    domain_reputation?: string;
    new_domain?: boolean;
    days_since_domain_creation?: number;
    suspicious_tld?: boolean;
    spam?: boolean;
    free_provider?: boolean;
    disposable?: boolean;
    deliverable?: boolean;
    accept_all?: boolean;
    profiles?: string[];
  };
}

export const emailRepSource: Source = {
  id: 'emailrep',
  label: 'Email reputation',
  accepts: ['email'],

  async run(subject, ctx) {
    const headers: Record<string, string> = { 'User-Agent': 'recon-bot', Accept: 'application/json' };
    if (config.emailRepKey) headers.Key = config.emailRepKey;

    let data: EmailRepResponse;
    try {
      data = await httpJson<EmailRepResponse>(`https://emailrep.io/${encodeURIComponent(subject.value)}`, {
        timeoutMs: 9000,
        cacheTtl: 86_400,
        headers,
      });
    } catch {
      return []; // rate-limited / unavailable — non-fatal
    }

    const d = data.details ?? {};
    const findings: Finding[] = [];

    const badges: string[] = [];
    if (d.disposable) badges.push('🔴 Throwaway/disposable email');
    if (data.suspicious) badges.push('⚠️ Flagged suspicious');
    if (d.malicious_activity || d.blacklisted) badges.push('🔴 Linked to malicious activity');
    if (d.spam) badges.push('⚠️ Associated with spam');
    if (d.credentials_leaked || d.data_breach) badges.push('🔓 Credentials/data leaked');

    const looksThin = data.reputation === 'none' || (data.references ?? 0) === 0;

    findings.push({
      source: 'emailrep',
      label: 'Email reputation',
      title: badges.length
        ? `📧 Email check: ${badges[0]!.replace(/^[🔴⚠️🔓]\s*/, '')}`
        : looksThin
          ? '📧 Email looks new/thin — little history'
          : `📧 Email looks established (${data.reputation} reputation)`,
      detail: [
        ...badges.slice(1),
        d.first_seen && `First seen: ${d.first_seen}`,
        data.references !== undefined && `Seen in ${data.references} place(s) online`,
        d.profiles?.length && `Registered on: ${d.profiles.slice(0, 8).join(', ')}`,
        d.new_domain && '⚠️ Email is on a brand-new domain',
        looksThin && 'A brand-new email with no history can be a fresh/burner account.',
      ]
        .filter(Boolean)
        .join('\n'),
      retrievedAt: ctx.now,
      confidence: badges.length ? 0.6 : 0.5,
    });

    return findings;
  },
};
