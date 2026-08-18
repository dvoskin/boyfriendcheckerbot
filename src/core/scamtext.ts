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
      'You are a romance/message scam detector. The user pastes a message someone sent them',
      '(often from a dating app or DM). Judge how likely it is a scam or manipulation.',
      '',
      'OPEN with a one-line verdict using one of: 🟢 Looks fine · 🟡 Be careful · 🔴 Scam signals.',
      'Then list the specific red flags you actually see, in plain words — e.g. moving off-app',
      'fast, sob story, asks for money/gift cards/crypto, investment/"I’ll teach you" talk,',
      'refuses video calls, love-bombing, urgency/pressure, "military/oil rig/overseas doctor",',
      'grammar that mismatches their claimed background. If it looks normal, say so honestly.',
      '',
      'Rules: judge ONLY the pasted text, never invent. Give confidence, not certainty. End with',
      'one concrete next step. Gender-neutral. Under 160 words, plain text.',
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
