/**
 * Empirically finds which sites soft-404 — answer HTTP 200 with a "not found"
 * page instead of a 404 status. Those sites produce false positives under
 * status-only detection, which is the difference between a useful report and a
 * list of URLs that merely resolve.
 *
 * For each site we probe handles that cannot exist. Any site reporting "found"
 * is unreliable, and we print its <title> plus candidate marker strings so a
 * discriminator can be added to the site table.
 *
 *   npx tsx src/scripts/calibrate.ts
 *   npx tsx src/scripts/calibrate.ts Reddit TikTok    # only these
 */
import { SITES_FOR_CALIBRATION } from '../sources/usernames.js';
import { probe } from '../core/http.js';

const NONEXISTENT = ['qx7vzmp4wknrt9bl', 'zzq4tmbvx8nphlrd', 'k3jf9wqzbxmtn7vl'];

const filter = process.argv.slice(2);
const sites = filter.length
  ? SITES_FOR_CALIBRATION.filter((s) => filter.includes(s.name))
  : SITES_FOR_CALIBRATION;

function titleOf(body: string): string {
  return /<title[^>]*>([\s\S]{0,160}?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, ' ').trim() ?? '(no title)';
}

/** Phrases that commonly mark an empty profile page; good marker candidates. */
const CANDIDATES = [
  'not found',
  "doesn't exist",
  'does not exist',
  'no such',
  'page not found',
  'user not found',
  'nothing here',
  "couldn't find",
  'could not find',
  'sorry',
  'unavailable',
  'removed',
  'deleted',
  'no longer available',
  'try again',
  '404',
];

const bad: string[] = [];
const good: string[] = [];

for (const site of sites) {
  const results: { status: number; body: string }[] = [];
  for (const handle of NONEXISTENT) {
    const res = await probe(site.url(handle), 8000);
    if (res) results.push(res);
  }

  if (results.length === 0) {
    console.log(`⛔ ${site.name.padEnd(22)} unreachable — all probes failed`);
    continue;
  }

  const looksFound = results.filter((r) => {
    if (r.status !== 200) return false;
    if (site.absent?.some((m) => r.body.includes(m))) return false;
    return true;
  });

  if (looksFound.length === 0) {
    good.push(site.name);
    console.log(`✅ ${site.name.padEnd(22)} correctly reports missing users`);
    continue;
  }

  bad.push(site.name);
  const sample = looksFound[0]!;
  const lower = sample.body.toLowerCase();
  const hits = CANDIDATES.filter((c) => lower.includes(c));
  console.log(`❌ ${site.name.padEnd(22)} FALSE POSITIVE (${looksFound.length}/${results.length} probes)`);
  console.log(`     title: ${titleOf(sample.body).slice(0, 100)}`);
  if (hits.length) console.log(`     candidate markers: ${hits.join(' | ')}`);
  console.log(`     body length: ${sample.body.length}`);
}

console.log(`\n=== ${good.length} reliable, ${bad.length} unreliable ===`);
if (bad.length) console.log(`Needs a marker or demotion: ${bad.join(', ')}`);
