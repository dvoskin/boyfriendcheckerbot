import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/**
 * "Is this a scam?" — paste a suspicious message and get a fast verdict. Rides a
 * documented $1.16B/yr romance-scam pain, analyses only content the user pasted
 * (low legal risk), and is a natural daily-reuse utility + upsell to a full check.
 */
export async function analyzeScamText(text: string): Promise<string | null> {
  if (!config.anthropicKey) return null;
  const client = new Anthropic({ apiKey: config.anthropicKey });

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 500,
    system: [
      'You are a romance/message scam detector. The user pastes a message someone sent them (often',
      'from a dating app or DM). Judge how likely it is a scam or manipulation. Gender-neutral.',
      'Under ~180 words. Use Telegram HTML: <b>bold</b> / <i>italics</i> only.',
      '',
      'Output EXACTLY this structure:',
      '',
      'Line 1 — verdict + a scam-likelihood <b>percentage</b>: one of 🟢 <b>Looks fine</b> /',
      '🟡 <b>Be careful</b> / 🔴 <b>Likely a scam</b>, then " — " then e.g. "78% scam signals".',
      '',
      'Line 2 — <b>Type:</b> the closest named pattern if any signals exist — Romance scam,',
      'Crypto/investment ("pig butchering"), Inheritance/beneficiary, Sextortion, Fake job,',
      'Package/delivery, or "No clear scam type".',
      '',
      'Then "🚩 <b>Tactics spotted</b>" with bullets — each names the tactic and QUOTES the exact',
      'phrase from the message in "quotes" that shows it (move off-app, sob story, money/gift-card/',
      'crypto ask, urgency, love-bombing, refuses video, overseas/military/oil-rig, off script).',
      '',
      'Then "🛡️ <b>Do this</b>:" 2–3 short, concrete safety steps matched to the type (e.g. never',
      'send money/gift cards, insist on a live video call, reverse-search their photos, report &',
      'block, don’t click links).',
      '',
      'Rules: judge ONLY the pasted text, never invent a quote. Confidence, not certainty. If it',
      'reads totally normal, say so plainly and keep it short.',
    ].join('\n'),
    messages: [{ role: 'user', content: `Message they sent me:\n"""${text.slice(0, 2000)}"""` }],
  });

  const out = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return out || null;
}
