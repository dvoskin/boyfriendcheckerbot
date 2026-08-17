import { createHash } from 'node:crypto';
import exifr from 'exifr';
import type { Finding } from '../core/types.js';

/**
 * Image *provenance*, deliberately not face recognition.
 *
 * Face matching is the one feature that would move this product from lawful
 * research into biometric liability: Illinois BIPA carries $1,000–5,000 per scan
 * with an active class-action bar, and Texas and Washington have their own
 * regimes. Provenance answers the useful questions anyway — where did this image
 * come from, was it edited, was it generated, and have we seen it before.
 */

interface ExifData {
  Make?: string;
  Model?: string;
  LensModel?: string;
  Software?: string;
  DateTimeOriginal?: Date | string;
  CreateDate?: Date | string;
  ModifyDate?: Date | string;
  Artist?: string;
  Copyright?: string;
  ImageDescription?: string;
  latitude?: number;
  longitude?: number;
  ExifImageWidth?: number;
  ExifImageHeight?: number;
  [key: string]: unknown;
}

/** Tool signatures that indicate synthetic or heavily edited imagery. */
const GENERATOR_HINTS = [
  'midjourney',
  'dall-e',
  'dalle',
  'stable diffusion',
  'stability',
  'firefly',
  'flux',
  'imagen',
  'sora',
  'runway',
  'leonardo',
  'nano banana',
  'gemini',
  'grok',
];

function fmtDate(v: Date | string | undefined): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  return String(v);
}

/**
 * C2PA Content Credentials are carried in a JUMBF box. Detecting the box tells us
 * credentials are present; validating the signature chain requires the c2pa
 * library, which is a heavier native dependency than V1 needs.
 */
function detectC2pa(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 512 * 1024)).toString('latin1');
  return window.includes('jumb') && (window.includes('c2pa') || window.includes('urn:uuid:'));
}

export async function analyzeImage(buf: Buffer, now: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  const sha256 = createHash('sha256').update(buf).digest('hex');
  findings.push({
    source: 'image',
    label: 'File',
    title: `${(buf.length / 1024).toFixed(0)} KB, SHA-256 ${sha256.slice(0, 16)}…`,
    detail:
      'Exact-file fingerprint. Store these to recognise re-uploads; add a perceptual hash (sharp + DCT) to catch resized and recompressed copies.',
    retrievedAt: now,
    confidence: 1,
    extra: { sha256 },
  });

  let exif: ExifData | undefined;
  try {
    // exifr accepts a boolean per segment at runtime, but its published types
    // declare ifd0 as an object-only option, so the block is cast as a whole.
    const options = {
      gps: true,
      ifd0: true,
      exif: true,
      xmp: true,
      icc: false,
      iptc: true,
    } as unknown as Parameters<typeof exifr.parse>[1];
    exif = (await exifr.parse(buf, options)) as ExifData | undefined;
  } catch {
    // Malformed or stripped metadata is normal, not an error.
  }

  if (!exif || Object.keys(exif).length === 0) {
    findings.push({
      source: 'image',
      label: 'EXIF',
      title: 'No EXIF metadata',
      detail:
        'Metadata was stripped. Normal for anything downloaded from a social platform — they strip on upload — so absence is not evidence of tampering.',
      retrievedAt: now,
      confidence: 0.9,
    });
  } else {
    const camera = [exif.Make, exif.Model].filter(Boolean).join(' ');
    const details = [
      camera && `Camera: ${camera}`,
      exif.LensModel && `Lens: ${exif.LensModel}`,
      exif.Software && `Software: ${exif.Software}`,
      fmtDate(exif.DateTimeOriginal) && `Taken: ${fmtDate(exif.DateTimeOriginal)}`,
      fmtDate(exif.ModifyDate) && `Modified: ${fmtDate(exif.ModifyDate)}`,
      exif.Artist && `Artist: ${exif.Artist}`,
      exif.Copyright && `Copyright: ${exif.Copyright}`,
      exif.ImageDescription && `Description: ${exif.ImageDescription}`,
      exif.ExifImageWidth && `Dimensions: ${exif.ExifImageWidth}×${exif.ExifImageHeight ?? '?'}`,
    ].filter(Boolean) as string[];

    if (details.length) {
      findings.push({
        source: 'image',
        label: 'EXIF',
        title: camera ? `Shot on ${camera}` : 'EXIF metadata present',
        detail: details.join('\n'),
        retrievedAt: now,
        confidence: 0.9,
      });
    }

    // GPS in EXIF is the single highest-value field in an image and survives
    // surprisingly often on files shared over email, chat and cloud drives.
    if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
      findings.push({
        source: 'image',
        label: 'GPS',
        title: `Geotagged: ${exif.latitude.toFixed(5)}, ${exif.longitude.toFixed(5)}`,
        detail: 'Coordinates embedded by the capturing device.',
        url: `https://www.google.com/maps?q=${exif.latitude},${exif.longitude}`,
        retrievedAt: now,
        confidence: 0.95,
        extra: { lat: exif.latitude, lon: exif.longitude },
      });
    }

    const softwareBlob = [exif.Software, exif.ImageDescription, JSON.stringify(exif.xmp ?? '')]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const generator = GENERATOR_HINTS.find((g) => softwareBlob.includes(g));
    if (generator) {
      findings.push({
        source: 'image',
        label: 'Synthetic media',
        title: `Metadata names an AI generator: ${generator}`,
        detail: 'Treat the image as generated or heavily edited unless proven otherwise.',
        retrievedAt: now,
        confidence: 0.8,
      });
    }
  }

  if (detectC2pa(buf)) {
    findings.push({
      source: 'image',
      label: 'C2PA',
      title: 'Content Credentials present',
      detail:
        'A C2PA/JUMBF manifest is embedded — it records capture device or editing history and whether AI was used. Full signature validation needs the c2pa library; this is detection only.',
      url: 'https://contentcredentials.org/verify',
      retrievedAt: now,
      confidence: 0.7,
    });
  }

  return findings;
}
