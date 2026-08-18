import Anthropic from '@anthropic-ai/sdk';
import { config } from '../core/config.js';

/**
 * AI red-flag reading of a screenshot the USER voluntarily gives us — their
 * match's dating profile, or a chat between them. This analyses the user's OWN
 * content (low legal risk: no third-party records, nothing stored), and returns
 * a warm, plain-English read of manipulation / scam / "taken" tells. It never
 * states defamatory facts — it points out patterns and what to check.
 */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export async function analyzeScreenshot(buf: Buffer, mime: ImageMime): Promise<string | null> {
  if (!config.anthropicKey) return null;
  const client = new Anthropic({ apiKey: config.anthropicKey });

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 800,
    system: [
      'You are the user’s sharp, protective friend reading a screenshot they took of',
      'someone they’re dating — either that person’s DATING PROFILE or a CHAT between them.',
      'Give a warm, plain, slightly sassy read. The user can be any gender and so can the',
      'person — stay gender-neutral (they/them). ~150–220 words.',
      '',
      'Look for and call out, in plain words, any of these patterns you actually see:',
      '- Love-bombing (over-the-top affection very fast, future-faking, "soulmate" in days).',
      '- Manipulation / gaslighting / guilt-tripping / pressure.',
      '- Romance-scam scripts (moving off-app fast, sob stories, crypto/investment talk,',
      '  emergencies needing money, refusing video calls, "working on an oil rig / military abroad").',
      '- "Taken/married" tells (only certain hours, cagey about weekends, hides their socials,',
      '  won’t be seen in public, vague about where they live).',
      '- Inconsistencies or things that don’t add up.',
      '- Green flags too — if it looks healthy and normal, say so honestly.',
      '',
      'Rules: describe only what is visible in THIS screenshot. Never invent. Label reads as',
      '"this looks like…", not fact. No diagnosis of the person. End with ONE concrete thing',
      'the user could ask or check to confirm. Open with a one-line gut-check verdict.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } },
          { type: 'text', text: 'Read this screenshot and give me the honest take. Is anything off?' },
        ],
      },
    ],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || null;
}
