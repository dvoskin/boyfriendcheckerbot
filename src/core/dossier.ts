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

/**
 * Pull "Name: X" style values out of finding details for cross-checking.
 * Only reads CONFIDENT findings — fuzzy name-search matches (a climate scientist,
 * a French YouTuber who happen to share a first name) are different people, and
 * treating their names as the subject's aliases produces a bogus "multiple names"
 * flag. Below the threshold, it is not his name.
 */
function extractNames(findings: Finding[]): string[] {
  const names = new Set<string>();
  for (const f of findings) {
    if (f.confidence < 0.7) continue;
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
    max_tokens: 1600,
    system: [
      'You are the user’s protective friend who just ran a public-records check on someone they’re',
      'dating. Write the way you’d TEXT a friend the verdict — warm, clear, plain English, no jargon,',
      'no data-dump. Everyday people who are NOT investigators must instantly get it. Gender-neutral:',
      'they/them for both the user and the person. ~120–180 words. Short.',
      '',
      'CRITICAL — the raw data is from an aggregator that MIXES IN THE WRONG PEOPLE. Be smart about it:',
      '- Relatives or records with a DIFFERENT last name, or tied to a far-away city, are usually NOT',
      '  this person — quietly IGNORE them, do not list them or treat them as real.',
      '- Use AGES to read relationships. A same-last-name relative who is ~20+ years older or younger',
      '  is a PARENT or a CHILD — never call them a partner. Only mention a possible spouse if a',
      '  same-surname relative is within ~10 years of their age AND it actually fits. When unsure, just',
      '  say "no marriage record — looks single, but worth confirming." NEVER call someone’s mom or',
      '  sibling a "possible partner" — that’s the mistake to avoid.',
      '',
      'Structure it as a few short lines the user can skim:',
      '1. One-line VERDICT (looks good / a couple things to check / be careful).',
      '2. WHO THEY ARE — real name, age, where they live, in one friendly sentence.',
      '3. SINGLE? — married record, or your best read on relationship (using the age logic above).',
      '4. SAFE? — any criminal/scam/registry hits in plain words, or "came back clean."',
      '5. ONE next step to confirm.',
      '',
      'Rules: use ONLY the findings given, never invent. Say "looks like / probably", never state',
      'guesses as fact. If the identity looks shaky (common name, no city), say so in one line. No',
      'confidence numbers, no headings-with-colons soup — just clean, human sentences.',
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
