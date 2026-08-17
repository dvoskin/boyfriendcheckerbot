import { tryCharge } from '../core/budget.js';
import { config } from '../core/config.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Phone lookup via Twilio Lookup v2 — the *legal* answer to GetContact. It returns
 * the name a number is officially registered under (CNAM/caller-ID), the line type
 * (mobile/landline/VoIP), and the carrier. Licensed telecom data, not harvested
 * from victims' address books, so it carries none of GetContact's legal problems.
 *
 * A VoIP line on someone claiming to be local, or a registered name that does not
 * match what he told you, are both meaningful signals for a safety check.
 *
 * Pluggable: returns null (skipped) unless Twilio credentials are configured.
 */
const LOOKUP = 'https://lookups.twilio.com/v2/PhoneNumbers';

interface CallerName {
  caller_name?: string | null;
  caller_type?: string | null;
}

interface LineTypeIntelligence {
  type?: string | null;
  carrier_name?: string | null;
  mobile_network_code?: string | null;
}

interface LookupResponse {
  valid?: boolean;
  phone_number?: string;
  national_format?: string;
  country_code?: string;
  caller_name?: CallerName | null;
  line_type_intelligence?: LineTypeIntelligence | null;
}

function toE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  // Bare 10-digit numbers are assumed US/Canada for this audience.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export const phoneSource: Source = {
  id: 'phone',
  label: 'Phone lookup',
  accepts: ['phone'],

  async run(subject, ctx) {
    if (!config.twilioSid || !config.twilioToken) return null;
    if (!(await tryCharge('phone'))) return null; // daily budget reached

    const e164 = toE164(subject.value);
    const auth = Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64');

    const res = await fetch(
      `${LOOKUP}/${encodeURIComponent(e164)}?Fields=caller_name,line_type_intelligence`,
      {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (res.status === 404) {
      return [
        {
          source: 'phone',
          label: 'Phone',
          title: `${e164} — not a valid number`,
          detail: 'Twilio could not resolve this number. Double-check the digits.',
          retrievedAt: ctx.now,
          confidence: 0.8,
        },
      ];
    }
    if (!res.ok) throw new Error(`Twilio lookup HTTP ${res.status}`);

    const data = (await res.json()) as LookupResponse;
    const cnam = data.caller_name?.caller_name?.trim();
    const line = data.line_type_intelligence;

    const detail = [
      cnam ? `Registered name: ${cnam}` : 'Registered name: not available',
      data.caller_name?.caller_type && `Type: ${data.caller_name.caller_type}`,
      line?.type && `Line: ${line.type}`,
      line?.carrier_name && `Carrier: ${line.carrier_name}`,
      data.country_code && `Country: ${data.country_code}`,
    ]
      .filter(Boolean)
      .join('\n');

    const findings: Finding[] = [
      {
        source: 'phone',
        label: 'Phone',
        title: cnam ? `📱 Registered to: ${cnam}` : `📱 ${data.national_format ?? e164}`,
        detail,
        retrievedAt: ctx.now,
        // CNAM is registration data, strong but not proof of current holder.
        confidence: cnam ? 0.75 : 0.5,
        extra: { registeredName: cnam, lineType: line?.type },
      },
    ];

    // A VoIP line is worth flagging — common in catfishing and burner setups.
    if (line?.type && /voip/i.test(line.type)) {
      findings.push({
        source: 'phone',
        label: 'Phone',
        title: '🟡 This is a VoIP/internet number',
        detail: 'Not a normal mobile line. Common for burner numbers and people hiding their real one.',
        retrievedAt: ctx.now,
        confidence: 0.7,
      });
    }

    return findings;
  },
};
