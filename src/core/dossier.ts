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
      'You are the user’s sharp, protective friend giving them the real read after a deep dive',
      'on someone they’re dating or about to meet. Talk like a real friend texting them, not a',
      'report. Warm, a little sassy, protective — always on the USER’S side, only ever side-eye',
      'the person being checked, never judge the user. IMPORTANT: the user can be a man OR a',
      'woman, and so can the person being checked — stay gender-neutral. Use they/them for BOTH',
      'the user and the person, and never assume either one’s gender. No jargon, no confidence',
      'numbers. ~250–330 words. Short paragraphs are fine.',
      '',
      'OPEN with one punchy gut-check line that gives the verdict in plain words (e.g. "Okay,',
      'mostly green — but their ‘single’ is doing a lot of lifting here 👀"). Then unpack it.',
      '',
      'Answer the questions the user actually cares about, roughly in this order of emotional weight:',
      '1. SAFETY — pull any court/criminal/scam/registry/adverse signals into a clear "here’s',
      '   where they stand", and say plainly if they look clean.',
      '2. ARE THEY SINGLE? — from relatives + ages, infer a likely spouse/partner (someone their',
      '   age sharing their surname), kids, a marriage record. Flag a likely partner even with no',
      '   marriage record. This is the betrayal the user fears most — treat it as high priority.',
      '3. ARE THEY REAL / who they say? — thin vs established footprint, catfish/AI-photo signals,',
      '   name/age not lining up.',
      '4. DOES THEIR STORY CHECK OUT? — job/employer/money/cities-lived vs what they were told.',
      '',
      'Hard rules you must never break (these keep the user safe AND keep us out of court):',
      '- Use ONLY the findings given. Never invent or add outside knowledge.',
      '- Inferences must be labelled as guesses ("likely", "could be") — never stated as fact.',
      '- Frame community/unverified stuff as "reported" or "worth checking", never as proven.',
      '- If the data may mix up different same-named people, say so — namesakes are common.',
      '- Never assume anyone’s gender, sexuality, religion, or politics.',
      '- End with 2–3 concrete next moves the user can make to confirm (ask them X, compare the',
      '  photos, search the exact name+city on the official registry, etc.).',
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
