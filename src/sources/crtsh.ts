import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Certificate Transparency is an append-only public log of every TLS certificate
 * issued. For our purposes that makes it two things at once: a complete
 * historical subdomain list (including hosts never linked from anywhere), and a
 * timeline of when infrastructure appeared — often earlier than any other record.
 *
 * crt.sh also exposes the raw Postgres behind this JSON view at
 * `psql -h crt.sh -p 5432 -U guest certwatch`, which is the right interface once
 * you want joins across issuers rather than one domain at a time.
 */
interface CertRow {
  issuer_name: string;
  common_name: string;
  name_value: string;
  not_before: string;
  not_after: string;
  entry_timestamp: string;
}

export const crtshSource: Source = {
  id: 'crtsh',
  label: 'Certificate Transparency',
  accepts: ['domain'],

  async run(subject, ctx) {
    const domain = subject.value.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!domain) return [];

    const rows = await httpJson<CertRow[]>(
      `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json&exclude=expired`,
      // crt.sh is frequently slow under load; give it room and cache generously.
      { timeoutMs: 11_000, cacheTtl: 43_200, retries: 2 },
    );

    if (!Array.isArray(rows) || rows.length === 0) return [];

    const hosts = new Set<string>();
    for (const row of rows) {
      for (const name of (row.name_value ?? '').split('\n')) {
        const clean = name.trim().toLowerCase();
        if (clean && !clean.startsWith('*')) hosts.add(clean);
      }
    }

    const issuers = new Map<string, number>();
    for (const row of rows) {
      const match = /O=([^,]+)/.exec(row.issuer_name ?? '');
      const issuer = match?.[1]?.trim() ?? 'unknown';
      issuers.set(issuer, (issuers.get(issuer) ?? 0) + 1);
    }

    const earliest = rows
      .map((r) => r.not_before)
      .filter(Boolean)
      .sort()[0];

    const sortedHosts = [...hosts].sort();
    const findings: Finding[] = [
      {
        source: 'crtsh',
        label: 'Certificate Transparency',
        title: `${sortedHosts.length} hostnames under ${domain}`,
        detail: [
          earliest && `First certificate: ${earliest.slice(0, 10)}`,
          `Issuers: ${[...issuers.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([name, n]) => `${name} (${n})`)
            .join(', ')}`,
        ]
          .filter(Boolean)
          .join('\n'),
        url: `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}`,
        retrievedAt: ctx.now,
        confidence: 0.95,
      },
    ];

    // Non-obvious hosts are the interesting ones: staging, admin, internal tools
    // and vendor integrations that nobody meant to publish.
    const notable = sortedHosts.filter((h) =>
      /(^|\.)(dev|staging|stage|test|qa|admin|internal|vpn|mail|api|git|jenkins|jira|crm|portal|beta|old|backup)\./.test(
        h,
      ),
    );
    if (notable.length) {
      findings.push({
        source: 'crtsh',
        label: 'Notable hosts',
        title: `${notable.length} internal-looking hostnames`,
        detail: notable.slice(0, 20).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.85,
      });
    }

    return findings;
  },
};
