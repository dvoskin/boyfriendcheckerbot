import { config } from '../core/config.js';
import type { Finding } from '../core/types.js';

/**
 * Reverse image search — the core catfish check. If his photo shows up attached
 * to other names or on stock/model sites, that is the tell.
 *
 * Face *recognition* is deliberately avoided (Illinois BIPA: $1k–5k per scan).
 * This searches for the same *image*, not the same face — a different thing both
 * technically and legally.
 *
 * Two moving parts: Google Lens (via SerpAPI) needs a publicly fetchable image
 * URL, and the Telegram file URL embeds the bot token, so we must NOT hand that
 * out. Instead we upload to Litterbox, which gives a throwaway URL that
 * auto-deletes in one hour — short-lived exposure, and never our token.
 */

const LITTERBOX = 'https://litterbox.catbox.moe/resources/internals/api.php';

/** Upload bytes to a temporary host; the URL self-destructs after an hour. */
async function uploadTemporary(buf: Buffer, filename: string): Promise<string | null> {
  try {
    const form = new FormData();
    form.set('reqtype', 'fileupload');
    form.set('time', '1h');
    form.set('fileToUpload', new Blob([new Uint8Array(buf)]), filename || 'image.jpg');

    const res = await fetch(LITTERBOX, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const url = (await res.text()).trim();
    return url.startsWith('http') ? url : null;
  } catch {
    return null;
  }
}

interface LensMatch {
  position?: number;
  title?: string;
  link?: string;
  source?: string;
  source_icon?: string;
}

interface LensResponse {
  visual_matches?: LensMatch[];
  error?: string;
}

/**
 * Run reverse image search. Returns null (skipped) when no SerpAPI key is set, so
 * the feature lights up the moment a key is added without touching this code.
 */
export async function reverseImageSearch(buf: Buffer, now: string): Promise<Finding[] | null> {
  if (!config.serpapiKey) return null;

  const hostedUrl = await uploadTemporary(buf, 'photo.jpg');
  if (!hostedUrl) {
    return [
      {
        source: 'reverse',
        label: 'Reverse image',
        title: 'Could not run reverse search',
        detail: 'Temporary image host was unreachable. Try again in a moment.',
        retrievedAt: now,
        confidence: 1,
      },
    ];
  }

  let data: LensResponse;
  try {
    const res = await fetch(
      `https://serpapi.com/search.json?engine=google_lens&type=all&url=${encodeURIComponent(hostedUrl)}&api_key=${config.serpapiKey}`,
      { signal: AbortSignal.timeout(25_000) },
    );
    data = (await res.json()) as LensResponse;
  } catch {
    return [
      {
        source: 'reverse',
        label: 'Reverse image',
        title: 'Reverse search failed',
        detail: 'The image search service did not respond.',
        retrievedAt: now,
        confidence: 1,
      },
    ];
  }

  const matches = (data.visual_matches ?? []).filter((m) => m.link);
  if (matches.length === 0) {
    return [
      {
        source: 'reverse',
        label: 'Reverse image',
        title: '✅ No copies of this photo found elsewhere',
        detail:
          'The image did not turn up on other sites. That is mildly reassuring for a catfish check, though not proof — a fresh photo will not match anything either.',
        retrievedAt: now,
        confidence: 0.6,
      },
    ];
  }

  const findings: Finding[] = [];

  // Distinct source domains carrying the same image. Many unrelated sources —
  // especially stock/model/dating sites — is the classic stolen-photo pattern.
  const sources = new Set(matches.map((m) => m.source).filter(Boolean));
  const stockish = matches.filter((m) => /shutterstock|istock|getty|dreamstime|adobe stock|123rf|pexels|unsplash|model|escort/i.test(`${m.source} ${m.title}`));

  const headline =
    stockish.length > 0
      ? '🔴 This photo appears on stock/model sites — likely NOT him'
      : sources.size >= 4
        ? `🟡 This photo appears on ${sources.size} different sites — worth a closer look`
        : `🔵 This photo appears on ${matches.length} other page(s)`;

  findings.push({
    source: 'reverse',
    label: 'Reverse image',
    title: headline,
    detail: stockish.length
      ? 'A stock-photo or model-site match usually means the picture was lifted, not taken by him.'
      : 'Review the pages below — do the names and context match who he says he is?',
    retrievedAt: now,
    confidence: stockish.length ? 0.75 : 0.55,
  });

  for (const m of matches.slice(0, 8)) {
    findings.push({
      source: 'reverse',
      label: m.source ?? 'Match',
      title: (m.title ?? m.link ?? '').slice(0, 120),
      url: m.link,
      retrievedAt: now,
      confidence: 0.4,
    });
  }

  return findings;
}
