import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import type { GraphResult } from './graph.js';
import type { Finding } from './types.js';

export interface Signal {
  level: 'red' | 'amber' | 'info';
  text: string;
}

export interface Dossier {
  signals: Signal[];
  narrative: string | null;
  identityCount: number;
  names: string[];
}

/** Pull "Name: X" style values out of finding details for cross-checking. */
function extractNames(findings: Finding[]): string[] {
  const names = new Set<string>();
  for (const f of findings) {
    for (const line of (f.detail ?? '').split('\n')) {
      const m = /^\s*Name:\s*(.+)$/i.exec(line);
      if (m?.[1]) names.add(m[1].trim());
    }
  }
  return [...names];
}

/**
 * Deterministic red-flag computation. These are facts, not AI opinions, so they
 * are shown to the user verbatim and never softened by the language model — the
 * one thing worse than missing a sanctions hit is inventing one, and vice versa.
 * The AI narrates around these; it does not produce them.
 */
export function computeSignals(graph: GraphResult): Signal[] {
  const all = graph.nodes.flatMap((n) => n.findings);
  const signals: Signal[] = [];

  // Sanctions / watchlist.
  const sanctions = all.filter((f) => f.source === 'ofac');
  for (const s of sanctions) {
    signals.push({ level: 'red', text: `Sanctions/watchlist possible match: ${s.title.replace(/^⚠️\s*/, '')}` });
  }

  // Synthetic or manipulated imagery — the classic catfish tell.
  if (all.some((f) => f.label === 'Synthetic media')) {
    signals.push({ level: 'red', text: 'A submitted image carries AI-generator metadata — treat photos as possibly fake.' });
  }
  const gps = all.find((f) => f.label === 'GPS');
  if (gps) signals.push({ level: 'info', text: `An image was geotagged: ${gps.title.replace(/^Geotagged:\s*/, '')}` });

  // Footprint size. A near-empty footprint on someone claiming an established
  // life is itself a signal — either a fresh alias or a fabricated persona.
  const confirmed = all.filter((f) => f.confidence >= 0.7 && ['usernames', 'github', 'bluesky'].includes(f.source));
  const identityCount = new Set(confirmed.map((f) => f.label + f.title)).size;
  if (identityCount === 0) {
    signals.push({ level: 'amber', text: 'No confirmed social accounts found — thin or freshly-created footprint.' });
  } else if (identityCount >= 8) {
    signals.push({ level: 'info', text: `${identityCount} confirmed accounts — established online footprint.` });
  }

  // Name consistency across independent sources.
  const names = extractNames(all);
  if (names.length >= 2) {
    signals.push({ level: 'amber', text: `Multiple names across sources: ${names.join(', ')} — verify these are the same person.` });
  }

  // Court records present.
  if (all.some((f) => f.source === 'courtlistener' && f.confidence >= 0.7)) {
    signals.push({ level: 'amber', text: 'Federal court records mention this subject — review before relying on them (non-FCRA).' });
  }

  return signals;
}

/**
 * Narrative pass over the whole graph. Grounded strictly in the findings and the
 * pre-computed signals; explicitly forbidden from inventing facts or merging
 * identities the data does not support. Serves every lens at once — safety,
 * legitimacy and identity — because the MVP is not specialised to one.
 */
export async function writeDossier(graph: GraphResult): Promise<Dossier> {
  const signals = computeSignals(graph);
  const all = graph.nodes.flatMap((n) => n.findings);
  const names = extractNames(all);
  const identityCount = new Set(
    all.filter((f) => f.confidence >= 0.7 && ['usernames', 'github', 'bluesky'].includes(f.source)).map((f) => f.label + f.title),
  ).size;

  if (!config.anthropicKey || all.length === 0) {
    return { signals, narrative: null, identityCount, names };
  }

  const client = new Anthropic({ apiKey: config.anthropicKey });
  const seed = graph.nodes.find((n) => n.id === graph.seedId)!;

  const payload = graph.nodes.map((n) => ({
    selector: `${n.kind}:${n.value}`,
    depth: n.depth,
    confidence: n.confidence,
    discoveredVia: n.via?.reason,
    findings: n.findings.map((f) => ({ source: f.label, title: f.title, detail: f.detail, confidence: f.confidence })),
  }));

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1100,
    system: [
      'You write an OSINT dossier from public-source findings for someone vetting a person.',
      'Structure, in plain text with these exact section headers:',
      'WHO — the most likely identity, or state clearly if the data describes multiple people or nobody identifiable.',
      'FOOTPRINT — confirmed accounts and linked selectors, grouped sensibly.',
      'ASSESSMENT — what the findings suggest for safety and legitimacy; call out consistency and contradictions.',
      'GAPS — what is missing or unverified.',
      'Hard rules:',
      '- Use ONLY the supplied findings. Never add outside knowledge.',
      '- Never merge two identities into one unless the links clearly support it; when unsure, say so.',
      '- Treat anything below 0.5 confidence as unconfirmed and label it.',
      '- No guesses about health, ethnicity, finances, or criminal history beyond what a cited finding states.',
      '- Under 350 words. No markdown, no bullet symbols, just the four headers and prose.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: `Seed: ${seed.kind}:${seed.value}\nPre-computed signals: ${JSON.stringify(signals)}\n\nGraph:\n${JSON.stringify(payload, null, 1)}`,
      },
    ],
  });

  const narrative = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return { signals, narrative: narrative || null, identityCount, names };
}
