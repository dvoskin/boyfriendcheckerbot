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
        title: '✅ Didn’t find this photo posted elsewhere',
        detail:
          'Good sign for a catfish check — though not proof, since a brand-new photo also matches nothing.',
        retrievedAt: now,
        confidence: 0.6,
      },
    ];
  }

  // IMPORTANT framing: Google Lens returns *visually similar* images, not only
  // exact copies. So a list of look-alikes is a LEAD to eyeball, never a verdict.
  // The old "stock/model site = not him" call was wrong and is removed — a
  // similar-looking stranger's photo is not evidence his picture was stolen.
  const findings: Finding[] = [
    {
      source: 'reverse',
      label: 'Reverse image',
      title: `🔎 Found ${matches.length} similar-looking image(s) online`,
      detail:
        'These look SIMILAR to his photo — not necessarily the same picture. Scan the names below: if his exact photo shows up under a DIFFERENT person’s name, that’s a catfish red flag. Look-alikes alone mean nothing.',
      retrievedAt: now,
      confidence: 0.45,
    },
  ];

  for (const m of matches.slice(0, 6)) {
    findings.push({
      source: 'reverse',
      label: m.source ?? 'Match',
      title: (m.title ?? m.link ?? '').slice(0, 120),
      url: m.link,
      retrievedAt: now,
      confidence: 0.35,
    });
  }

  return findings;
}
