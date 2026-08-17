import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * rdap.org follows IANA's bootstrap registry to the authoritative server for us,
 * so we do not have to maintain a TLD-to-server map ourselves.
 *
 * RDAP replaced port-43 WHOIS as the required protocol for gTLDs (WHOIS sunset
 * Jan 2025), so this is the current interface, not a modern alternative to it.
 */
const RDAP = 'https://rdap.org/domain';

interface VcardEntry extends Array<unknown> {
  0: string;
  3?: unknown;
}

interface Entity {
  roles?: string[];
  handle?: string;
  vcardArray?: [string, VcardEntry[]];
}

interface RdapDomain {
  ldhName?: string;
  handle?: string;
  status?: string[];
  events?: { eventAction: string; eventDate: string }[];
  entities?: Entity[];
  nameservers?: { ldhName?: string }[];
}

function vcardField(entity: Entity, field: string): string | undefined {
  const entries = entity.vcardArray?.[1] ?? [];
  for (const e of entries) {
    if (e[0] === field && typeof e[3] === 'string' && e[3].trim()) return e[3].trim();
  }
  return undefined;
}

export const rdapSource: Source = {
  id: 'rdap',
  label: 'ICANN RDAP',
  accepts: ['domain'],

  async run(subject, ctx) {
    const domain = subject.value.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!domain) return [];

    const data = await httpJson<RdapDomain>(`${RDAP}/${encodeURIComponent(domain)}`, {
      timeoutMs: 8000,
      cacheTtl: 21_600,
    });

    const findings: Finding[] = [];
    const events = new Map((data.events ?? []).map((e) => [e.eventAction, e.eventDate]));

    const summary = [
      data.handle && `Registry ID: ${data.handle}`,
      events.get('registration') && `Registered: ${events.get('registration')!.slice(0, 10)}`,
      events.get('expiration') && `Expires: ${events.get('expiration')!.slice(0, 10)}`,
      events.get('last changed') && `Last changed: ${events.get('last changed')!.slice(0, 10)}`,
      data.status?.length && `Status: ${data.status.join(', ')}`,
      data.nameservers?.length &&
        `Nameservers: ${data.nameservers.map((n) => n.ldhName).filter(Boolean).join(', ')}`,
    ].filter(Boolean) as string[];

    findings.push({
      source: 'rdap',
      label: 'ICANN RDAP',
      title: `Domain ${data.ldhName ?? domain}`,
      detail: summary.join('\n'),
      url: `https://rdap.org/domain/${domain}`,
      retrievedAt: ctx.now,
      confidence: 0.95,
    });

    // Registrant contact data is redacted for most individual registrants under
    // GDPR/ICANN policy. Registrar and organisation-level entries usually survive,
    // so report what is actually there rather than implying we found an owner.
    for (const entity of data.entities ?? []) {
      const name = vcardField(entity, 'fn') ?? vcardField(entity, 'org');
      if (!name) continue;
      const roles = entity.roles?.join(', ') ?? 'unknown role';
      if (/redacted|privacy|not disclosed|data protected/i.test(name)) continue;

      const contact = [
        vcardField(entity, 'org') && `Org: ${vcardField(entity, 'org')}`,
        vcardField(entity, 'email') && `Email: ${vcardField(entity, 'email')}`,
        vcardField(entity, 'tel') && `Phone: ${vcardField(entity, 'tel')}`,
      ].filter(Boolean) as string[];

      findings.push({
        source: 'rdap',
        label: `RDAP ${roles}`,
        title: name,
        detail: contact.length ? contact.join('\n') : `Role: ${roles}`,
        retrievedAt: ctx.now,
        confidence: 0.7,
      });
    }

    return findings;
  },
};
