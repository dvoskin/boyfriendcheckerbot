import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { config } from '../core/config.js';

/**
 * Downscale/re-encode so the vision API never 400s on a huge screenshot. The
 * Anthropic API caps images ~5MB and the long edge around 1568px, but Telegram
 * documents can be far bigger — so we cap the long edge and re-encode as JPEG.
 */
async function fitForVision(buf: Buffer): Promise<{ data: Buffer; mime: 'image/jpeg' }> {
  const out = await sharp(buf, { failOn: 'none' })
    .rotate() // respect EXIF orientation
    .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { data: out, mime: 'image/jpeg' };
}

/**
 * AI red-flag reading of a screenshot the USER voluntarily gives us — their
 * match's dating profile, or a chat between them. This analyses the user's OWN
 * content (low legal risk: no third-party records, nothing stored), and returns
 * a warm, plain-English read of manipulation / scam / "taken" tells. It never
 * states defamatory facts — it points out patterns and what to check.
 */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export async function analyzeScreenshot(buf: Buffer, _mime: ImageMime): Promise<string | null> {
  if (!config.anthropicKey) return null;
  const client = new Anthropic({ apiKey: config.anthropicKey });
  // Always normalize the image so oversized shots don't fail the vision call.
  const { data, mime } = await fitForVision(buf).catch(() => ({ data: buf, mime: 'image/jpeg' as const }));

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 800,
    system: [
      'You are the user’s sharp, protective friend reading a screenshot they took of someone',
      'they’re dating — that person’s DATING PROFILE or a CHAT between them. The user can be any',
      'gender and so can the person — stay gender-neutral (they/them). Warm, plain, a little',
      'sassy. Under ~230 words. Use Telegram HTML: <b>bold</b> and <i>italics</i> only.',
      '',
      'Output EXACTLY this structure:',
      '',
      'Line 1 — the verdict: one of 🟢 <b>Looks healthy</b> / 🟡 <b>A few yellow flags</b> /',
      '🔴 <b>Big red flags</b>, then " — " then a confidence word (low/medium/high), then a',
      'short gut-check sentence.',
      '',
      'Then "🚩 <b>What stood out</b>" and 2–5 bullets. EACH bullet MUST:',
      '  • name the pattern in bold (Love-bombing, Scam script, Taken/married tell, Gaslighting,',
      '    Pressure, Inconsistency, Future-faking, Money ask, Avoids video), then',
      '  • quote the EXACT words from the screenshot in "quotes" as the evidence, then',
      '  • one short clause on why it matters.',
      '  Quoting their actual words is the whole point — always cite the line that triggered it.',
      '',
      'Then "💚 <b>Good signs</b>" with any genuine green flags (skip the header if none).',
      'Then "🎯 <b>Ask them</b>:" with ONE specific question that would confirm or clear the biggest flag.',
      '',
      'Hard rules: use ONLY what is visible in THIS screenshot — never invent a quote or a fact.',
      'Frame reads as "looks like / reads as", not proven fact. No diagnosis of the person. If the',
      'image is too blurry or has no readable text, say so and ask them to resend a clearer shot.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } },
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
