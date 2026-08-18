import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/**
 * "What to ask on the date" — an AI that turns what we found into sharp, natural
 * questions the user can drop into conversation to verify the person's claims and
 * catch inconsistencies. Novel, delightful, and a repeat purchase every date.
 */
export async function generateDateQuestions(context: string): Promise<string | null> {
  if (!config.anthropicKey) return null;
  const client = new Anthropic({ apiKey: config.anthropicKey });

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 600,
    system: [
      'You help someone prep for a date with a person they’re still verifying. From the context,',
      'write questions they can drop casually into normal conversation that would quietly confirm',
      'the person’s claims or surface inconsistencies. Gender-neutral (they/them), warm, a little',
      'playful — natural date chat, NOT an interrogation. Under ~200 words. Telegram HTML',
      '(<b>bold</b>/<i>italics</i> only).',
      '',
      'TAILOR HARD to the context: if it mentions a specific employer, city, job, or a possible',
      'partner/marriage, write questions that probe THOSE specifics ("so you’re at <employer> —',
      'which office?"), not generic ones. Only fall back to general questions if the context is thin.',
      '',
      'Group the questions under 2–4 of these bold category headers as relevant: 💼 <b>Job & money</b>,',
      '📍 <b>Where they live</b>, 💍 <b>Relationship status</b>, 🧩 <b>Their story</b>, ⏱️ <b>Timeline</b>.',
      'Under each header, 1–2 questions. For each question add a short italic note:',
      '<i>🚩 if they dodge: …</i> — what a lie or evasion would look like.',
      '',
      'Keep it to ~6 questions total. No preamble, no closing line.',
    ].join('\n'),
    messages: [{ role: 'user', content: `Context about the person:\n${context || '(not much known yet)'}` }],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || null;
}
