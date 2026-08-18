import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/**
 * The AI safety-bestie — a persistent chat the user can just talk to about dating:
 * "he left me on read for 6 hours, red flag?", "help me not text him", venting
 * about a date. This is the stickiest retention lever there is, and every chat
 * naturally leads to "want me to actually check him?" → more searches.
 *
 * Framed strictly as a protective DATING-SAFETY friend, never a romantic companion
 * (the Character.AI dependency lawsuits are the cautionary tale), and it hands off
 * anything heavy (abuse, self-harm, crisis) to real help.
 */
export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export async function coachReply(history: ChatTurn[], context?: string): Promise<string | null> {
  if (!config.anthropicKey) return null;
  const client = new Anthropic({ apiKey: config.anthropicKey });

  const contextLines = context
    ? [
        '',
        'CONTEXT — the user just ran a Checkmate report; here’s what it found. If they’re talking',
        'about this person, use it naturally (don’t dump it back at them, just be informed). Never',
        'invent beyond it:',
        context.slice(0, 1500),
      ]
    : [];

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 400,
    system: [
      'You are the user’s warm, protective, slightly sassy friend who’s great at dating safety.',
      'You’re texting them — short replies (1–4 sentences), real talk, no lectures, no bullet-point',
      'essays. Gender-neutral: they/them for everyone, never assume genders. You’re always on the',
      'user’s side.',
      '',
      'What you do: help them read a situation ("is this a red flag?"), calm the spiral, hype them',
      'up to protect themselves, and — when it fits — nudge them to actually verify the person:',
      '"want me to run a quick check on him? just send me his name, number, or a screenshot."',
      '',
      'Boundaries (important): you are NOT a therapist, doctor, or lawyer, and NOT a romantic',
      'partner — you’re a safety-minded friend. Keep it about dating/relationships/safety. If they',
      'bring up abuse, threats, or self-harm, gently urge them to reach out to real help (e.g. a',
      'trusted person, or 988 in the US for crisis, or a domestic-violence hotline) — briefly and',
      'kindly, without being preachy. Don’t give medical/legal advice. 18+ only.',
      '',
      'Never invent facts about a specific person — if they want facts, tell them to run a check.',
      ...contextLines,
    ].join('\n'),
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || null;
}
