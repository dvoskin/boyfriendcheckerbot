import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * IPQualityScore — fraud/risk scoring for a phone or email. The catfish-detector:
 * flags VoIP/burner phones, disposable/temporary emails, recent abuse, and a
 * fraud score. "Is this a real number/email or a throwaway" is exactly what a
 * dating-safety check needs. Pluggable: free API key.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const ipqsSource: Source = {
  id: 'ipqs',
  label: 'Fraud check',
  accepts: ['phone', 'email'],

  async run(subject, ctx) {
    if (!config.ipqsKey) return null;

    const kind = subject.kind;
    const endpoint =
      kind === 'phone'
        ? `https://ipqualityscore.com/api/json/phone/${config.ipqsKey}/${encodeURIComponent(subject.value.replace(/[^\d+]/g, ''))}`
        : `https://ipqualityscore.com/api/json/email/${config.ipqsKey}/${encodeURIComponent(subject.value)}`;

    const d = await httpJson<any>(endpoint, { timeoutMs: 10_000, cacheTtl: 86_400 });
    if (d.success === false) return [];

    const flags: string[] = [];
    if (kind === 'phone') {
      if (d.VOIP || d.voip) flags.push('🟡 VoIP / internet number (common for burners)');
      if (d.prepaid) flags.push('🟡 Prepaid / burner-style line');
      if (d.risky || d.fraud_score >= 75) flags.push('🔴 High-risk / flagged number');
      if (d.active === false) flags.push('⚠️ Number appears inactive');
      const info = [d.carrier && `Carrier: ${d.carrier}`, d.line_type && `Line: ${d.line_type}`, d.name && `Name: ${d.name}`].filter(Boolean).join(' · ');
      return [
        {
          source: 'ipqs',
          label: 'Phone fraud check',
          title: flags.length ? `📱 ${flags[0]}` : '📱 Phone looks like a normal, real line ✅',
          detail: [...flags.slice(1), info, `Fraud score: ${d.fraud_score ?? '?'} / 100`].filter(Boolean).join('\n'),
          retrievedAt: ctx.now,
          confidence: 0.6,
        },
      ];
    }

    // email
    if (d.disposable) flags.push('🔴 Disposable/throwaway email');
    if (d.recent_abuse) flags.push('🔴 Recent abuse/fraud reports');
    if (d.fraud_score >= 75) flags.push('🔴 High fraud score');
    if (d.honeypot) flags.push('⚠️ Honeypot/spam-trap address');
    if (typeof d.first_seen?.human === 'string') flags.push(`First seen: ${d.first_seen.human}`);
    return [
      {
        source: 'ipqs',
        label: 'Email fraud check',
        title: flags.length ? `📧 ${flags[0]}` : '📧 Email looks legit ✅',
        detail: [...flags.slice(1), `Fraud score: ${d.fraud_score ?? '?'} / 100`].filter(Boolean).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.6,
      },
    ];
  },
};
