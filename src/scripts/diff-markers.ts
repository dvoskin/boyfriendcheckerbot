/**
 * Finds a discriminator for a soft-404 site by fetching a profile that exists
 * and one that cannot, then reporting distinctive phrases present in the
 * missing-user page but absent from the real one. Those phrases are the
 * `absent` markers for the site table.
 *
 *   npx tsx src/scripts/diff-markers.ts 'https://www.reddit.com/user/{}/' spez
 */
import { probe } from '../core/http.js';

const [, , template, realHandle] = process.argv;
if (!template || !realHandle) {
  console.error("usage: diff-markers.ts 'https://site.com/{}/' <real-handle>");
  process.exit(1);
}

const FAKE = 'qx7vzmp4wknrt9bl';
const build = (h: string) => template.replace('{}', h);

const [real, fake] = await Promise.all([probe(build(realHandle), 12_000), probe(build(FAKE), 12_000)]);

console.log(`real  ${realHandle}: status ${real?.status ?? 'ERR'}, ${real?.body.length ?? 0} bytes`);
console.log(`fake  ${FAKE}: status ${fake?.status ?? 'ERR'}, ${fake?.body.length ?? 0} bytes`);

if (!real?.body || !fake?.body) {
  console.log('\nOne side did not return a body — status alone may be the discriminator.');
  process.exit(0);
}

/** Sentence-ish fragments, which make more stable markers than single words. */
function phrases(body: string): Set<string> {
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Z][^.!?]{12,90}[.!?]/g)) out.add(m[0].trim());
  return out;
}

const realPhrases = phrases(real.body);
const onlyInFake = [...phrases(fake.body)].filter((p) => !realPhrases.has(p));

console.log('\n--- phrases only on the missing-user page (candidate `absent` markers) ---');
for (const p of onlyInFake.slice(0, 25)) console.log(`  "${p}"`);

// Title comparison is often the cleanest signal of all.
const titleOf = (b: string) => /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(b)?.[1]?.trim();
console.log(`\nreal title: ${titleOf(real.body)}`);
console.log(`fake title: ${titleOf(fake.body)}`);
