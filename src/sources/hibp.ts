import { config } from '../core/config.js';
import { httpGet } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * HaveIBeenPwned — which data breaches his email turned up in. This is the
 * closest legal signal to "does he have hidden / dating-app accounts": if his
 * email is in a dating-service breach he had an account there, and any breach at
 * all reveals accounts he never mentioned plus how long his email has existed.
 *
 * It exposes only breach METADATA (which site, when, what kind of data) — never
 * passwords or leaked content. Legal security tooling. Needs a paid API key.
 */
const API = 'https://haveibeenpwned.com/api/v3/breachedaccount';

interface Breach {
  Name?: string;
  Title?: string;
  Domain?: string;
  BreachDate?: string;
  DataClasses?: string[];
}

/** Breach names/domains that imply a dating or adult service — high signal. */
const DATING_HINT = /dating|tinder|match|bumble|hinge|okcupid|ashley|adult|fling|hookup|cupid|zoosk|badoo|grindr|meetme|plenty/i;

export const hibpSource: Source = {
  id: 'hibp',
  label: 'Email breaches',
  accepts: ['email'],

  async run(subject, ctx) {
    if (!config.hibpKey) return null;

    const { status, body } = await httpGet(`${API}/${encodeURIComponent(subject.value)}?truncateResponse=false`, {
      timeoutMs: 10_000,
      cacheTtl: 86_400,
      headers: { 'hibp-api-key': config.hibpKey, 'user-agent': 'recon-bot' },
      // 404 = clean (no breaches). Treat as a valid answer, not an error.
      allowStatus: [404],
    });

    if (status === 404) {
      return [
        {
          source: 'hibp',
          label: 'Email breaches',
          title: `✅ ${subject.value} — not in any known breach`,
          detail: 'His email hasn’t shown up in known data leaks. Could mean good hygiene — or a fresh email he just made.',
          retrievedAt: ctx.now,
          confidence: 0.7,
        },
      ];
    }

    const breaches = JSON.parse(body) as Breach[];

    // Pastes: the email appearing in a public paste (Pastebin etc.) — often a
    // dump of usernames/passwords, a stronger "this got leaked" signal. Same key.
    const findings: Finding[] = [];
    try {
      const paste = await httpGet(`https://haveibeenpwned.com/api/v3/pasteaccount/${encodeURIComponent(subject.value)}`, {
        timeoutMs: 8000,
        cacheTtl: 86_400,
        headers: { 'hibp-api-key': config.hibpKey, 'user-agent': 'recon-bot' },
        allowStatus: [404],
      });
      if (paste.status === 200) {
        const pastes = JSON.parse(paste.body) as { Source?: string; Title?: string; Date?: string }[];
        if (Array.isArray(pastes) && pastes.length > 0) {
          findings.push({
            source: 'hibp',
            label: 'Pastes',
            title: `📄 Email found in ${pastes.length} public paste(s)`,
            detail: pastes
              .slice(0, 4)
              .map((p) => `${p.Source ?? 'Paste'}${p.Date ? ` (${p.Date.slice(0, 10)})` : ''}`)
              .join('\n'),
            retrievedAt: ctx.now,
            confidence: 0.5,
          });
        }
      }
    } catch {
      // Pastes are a bonus; a failure here shouldn't sink the breach result.
    }

    if ((!Array.isArray(breaches) || breaches.length === 0) && findings.length === 0) return [];
    if (!Array.isArray(breaches) || breaches.length === 0) return findings;

    const dating = breaches.filter((b) => DATING_HINT.test(`${b.Name} ${b.Domain} ${b.Title}`));
    const dates = breaches.map((b) => b.BreachDate).filter(Boolean).sort();
    findings.unshift(
      {
        source: 'hibp',
        label: 'Email breaches',
        title: `📭 In ${breaches.length} data breach(es)${dating.length ? ' — including a DATING/ADULT site 👀' : ''}`,
        detail: [
          dates[0] && `Email active since at least ${dates[0].slice(0, 4)} (older = more established).`,
          dating.length && `⚠️ Dating/adult breach: ${dating.map((b) => b.Title || b.Name).join(', ')}`,
        ]
          .filter(Boolean)
          .join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.6,
      },
    );

    for (const b of breaches.slice(0, 10)) {
      findings.push({
        source: 'hibp',
        label: 'Breach',
        title: `${b.Title || b.Name}${b.BreachDate ? ` (${b.BreachDate.slice(0, 4)})` : ''}`,
        detail: b.DataClasses?.length ? `Leaked: ${b.DataClasses.slice(0, 5).join(', ')}` : undefined,
        retrievedAt: ctx.now,
        confidence: 0.45,
      });
    }
    return findings;
  },
};
