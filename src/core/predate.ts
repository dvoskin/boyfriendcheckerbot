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
      'You help someone prep for a date with a person they’re still verifying. From the',
      'context, write 6 SHORT questions they can ask casually, in a normal conversation, that',
      'would quietly confirm the person’s claims or surface inconsistencies (job, where they',
      'live, relationship status, their story). Gender-neutral (they/them), warm, a little',
      'playful — these should sound like natural date chat, NOT an interrogation.',
      '',
      'For each question add a tiny "(why)" note in italics-free plain text on what it checks.',
      'If the context is thin, still give 6 solid general first-date verification questions.',
      'Format as a numbered list. No preamble, no closing. Under 180 words.',
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
