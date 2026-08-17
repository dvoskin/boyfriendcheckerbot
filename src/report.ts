import Anthropic from '@anthropic-ai/sdk';
import { config } from './core/config.js';
import type { Dossier } from './core/dossier.js';
import type { GraphResult } from './core/graph.js';
import type { Finding, SourceResult, Subject } from './core/types.js';

const TELEGRAM_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Live progress line, edited in place while sources are still landing. */
export function renderProgress(done: SourceResult[], pending: string[]): string {
  const lines: string[] = ['<b>Searching…</b>', ''];

  for (const r of done) {
    const icon = !r.ok ? '⚠️' : r.skipped ? '⏭' : r.findings.length ? '✅' : '·';
    const note = !r.ok
      ? `failed (${escapeHtml(r.error ?? 'unknown')})`
      : r.skipped
        ? 'skipped — no key configured'
        : r.findings.length
          ? `${r.findings.length} hit${r.findings.length === 1 ? '' : 's'}`
          : 'nothing';
    lines.push(`${icon} <b>${escapeHtml(r.label)}</b> — ${note} <i>${r.ms}ms</i>`);
  }

  for (const label of pending) {
    lines.push(`⏳ <b>${escapeHtml(label)}</b> — running`);
  }

  return lines.join('\n').slice(0, TELEGRAM_LIMIT);
}

function renderFinding(f: Finding): string {
  const parts: string[] = [];
  const weak = f.confidence < 0.5 ? ' <i>(possible)</i>' : '';
  const title = f.url
    ? `<a href="${escapeHtml(f.url)}">${escapeHtml(f.title)}</a>`
    : `<b>${escapeHtml(f.title)}</b>`;
  parts.push(`• ${title}${weak}`);
  if (f.detail) {
    for (const line of f.detail.split('\n').slice(0, 8)) {
      parts.push(`  <i>${escapeHtml(line)}</i>`);
    }
  }
  return parts.join('\n');
}

/**
 * Chunk on finding boundaries so a message never splits mid-entity. Telegram
 * hard-caps at 4096 characters and silently rejects anything longer.
 */
export function renderFindings(subject: Subject, results: SourceResult[]): string[] {
  const withHits = results.filter((r) => r.ok && r.findings.length > 0);
  const empty = results.filter((r) => r.ok && !r.skipped && r.findings.length === 0);
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);

  const header = [
    `<b>${escapeHtml(subject.raw)}</b> — ${escapeHtml(subject.kind)}`,
    `${withHits.reduce((n, r) => n + r.findings.length, 0)} findings across ${withHits.length} sources`,
    '',
  ].join('\n');

  const blocks: string[] = [];
  for (const result of withHits) {
    const body = result.findings.map(renderFinding).join('\n');
    blocks.push(`<b>━━ ${escapeHtml(result.label)}</b>\n${body}`);
  }

  // Gaps are part of the answer. A source that failed silently would make the
  // report look complete when it is not.
  const footer: string[] = [];
  if (empty.length) footer.push(`<i>No results: ${empty.map((r) => escapeHtml(r.label)).join(', ')}</i>`);
  if (failed.length)
    footer.push(
      `<i>⚠️ Failed: ${failed.map((r) => `${escapeHtml(r.label)} (${escapeHtml(r.error ?? '')})`).join('; ')}</i>`,
    );
  if (skipped.length)
    footer.push(`<i>⏭ Not configured: ${skipped.map((r) => escapeHtml(r.label)).join(', ')}</i>`);

  const chunks: string[] = [];
  let current = header;
  for (const block of [...blocks, footer.join('\n')].filter(Boolean)) {
    if (current.length + block.length + 2 > TELEGRAM_LIMIT) {
      chunks.push(current);
      current = block;
    } else {
      current += (current ? '\n\n' : '') + block;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

const SIGNAL_ICON = { red: '🔴', amber: '🟡', info: '🔵' } as const;

/** Split a long section on line boundaries to respect Telegram's 4096 cap. */
function chunk(sections: string[]): string[] {
  const out: string[] = [];
  for (const section of sections) {
    if (section.length <= TELEGRAM_LIMIT) {
      out.push(section);
      continue;
    }
    let cur = '';
    for (const line of section.split('\n')) {
      if (cur.length + line.length + 1 > TELEGRAM_LIMIT) {
        out.push(cur);
        cur = line;
      } else {
        cur += (cur ? '\n' : '') + line;
      }
    }
    if (cur.trim()) out.push(cur);
  }
  return out;
}

/**
 * The reader-facing report. Built for a non-technical person checking someone
 * out: safety first, plain words, clickable accounts, and honest hedging where
 * the data is weak. No confidence numbers, no "selectors", no raw trees — those
 * live in /g for power users. One clean story, top to bottom.
 */
export function renderReport(seed: Subject, graph: GraphResult, dossier: Dossier): string[] {
  const all = graph.nodes.flatMap((n) => n.findings);
  const sections: string[] = [];

  // ── 1. Headline + traffic-light quick take + flags ───────────────────────
  const hasRed = dossier.signals.some((s) => s.level === 'red');
  const hasAmber = dossier.signals.some((s) => s.level === 'amber');
  const light = hasRed ? '🔴' : hasAmber ? '🟡' : '🟢';
  const take = hasRed
    ? 'ooh, a couple of things we should look at, bestie 👀'
    : hasAmber
      ? 'mostly good — just a couple things to double-check 💫'
      : 'nothing scary jumped out ✨';

  // ── 1. Summary card — header + the at-a-glance answers, ONE opening bubble ─
  const flags = dossier.signals.filter((s) => s.level !== 'info');
  const idf = all.find((f) => f.source === 'enformion' && f.label === 'Identity');
  const relf = all.find((f) => f.source === 'enformion' && f.label === 'Relationship status');
  const fecf = all.find((f) => f.source === 'fec');
  const age = idf?.extra?.age as string | undefined;
  const city = idf?.extra?.city as string | undefined;
  const relStatus = relf?.extra?.status as string | undefined;
  const employer = fecf?.extra?.employer as string | undefined;
  const occupation = fecf?.extra?.occupation as string | undefined;
  const redFlagCount =
    dossier.signals.filter((s) => s.level === 'red').length + all.filter((f) => f.source === 'adverse' && /🚨/.test(f.title)).length;

  const summary = [`💅 <b>The tea on ${escapeHtml(seed.raw)}</b>`, '', `${light} <b>Quick take:</b> ${take}`];
  // The at-a-glance answers, folded right into the opener.
  const facts: string[] = [];
  if (age) facts.push(`🎂 <b>Age:</b> ${escapeHtml(age)}`);
  if (city) facts.push(`📍 <b>Lives:</b> ${escapeHtml(city)}`);
  if (relStatus) {
    const rel = relStatus === 'married' ? '💍 Married — careful!' : relStatus === 'divorced' ? '💔 Divorced' : '💚 No marriage record (looks single)';
    facts.push(`💘 <b>Relationship:</b> ${rel}`);
  }
  if (employer || occupation) facts.push(`💼 <b>Works:</b> ${escapeHtml([occupation, employer].filter(Boolean).join(' @ '))}`);
  if (facts.length) summary.push('', ...facts);
  if (flags.length) {
    summary.push('', '🚩 <b>Keep an eye on:</b>');
    for (const s of [...flags].sort((a, b) => (a.level === 'red' ? -1 : 1))) summary.push(`${SIGNAL_ICON[s.level]} ${escapeHtml(s.text)}`);
  } else if (facts.length) {
    summary.push('', '🚩 <b>Red flags:</b> none so far ✨');
  }
  sections.push(summary.join('\n'));

  // ── 2. The AI read comes SECOND — the story before the evidence ──────────
  if (dossier.narrative) sections.push(`💭 <b>My honest read</b>\n\n${escapeHtml(dossier.narrative)}`);

  // ── 3. Is he safe? — highest-stakes, never diluted ───────────────────────
  const safety = all.filter((f) => ['registry', 'ofac', 'adverse', 'scam', 'unicourt'].includes(f.source));
  if (safety.length) {
    safety.sort((a, b) => b.confidence - a.confidence);
    const s = ['🛡️ <b>Is he safe?</b>', ''];
    for (const f of safety) {
      s.push(f.url ? `• <a href="${escapeHtml(f.url)}">${escapeHtml(f.title)}</a>` : `• ${escapeHtml(f.title)}`);
      const first = f.detail?.split('\n')[0];
      if (first) s.push(`  <i>${escapeHtml(first)}</i>`);
    }
    sections.push(s.join('\n'));
  }

  // ── 3.5 The real him — the richest personal data, kept high ──────────────
  const deep = all.filter((f) => f.source === 'enformion');
  if (deep.length) {
    const d = ['💜 <b>The real him</b>', ''];
    for (const f of deep) {
      d.push(`<b>${escapeHtml(f.title)}</b>`);
      if (f.detail) for (const line of f.detail.split('\n')) d.push(escapeHtml(line));
      d.push('');
    }
    d.push('<i>💡 Public-records data — powerful but not perfect. Double-check it’s the right person (age + city).</i>');
    sections.push(d.join('\n'));
  }

  // ── 4. Accounts, split into "very likely him" vs "same handle, verify" ───
  const acctText = (f: (typeof all)[number]): string =>
    f.source === 'usernames' ? f.label : `${f.label} ${f.title}`;

  const seen = new Set<string>();
  const social = all.filter((f) => {
    if (!f.url || !['usernames', 'github', 'bluesky'].includes(f.source)) return false;
    if (f.confidence < 0.5) return false; // drop fuzzy same-name strangers
    if (seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });
  const strong = social.filter((f) => f.confidence >= 0.7);
  const weak = social.filter((f) => f.confidence < 0.7);

  // Direct social profiles found on the web (his actual Instagram/LinkedIn/etc).
  const socialSeen = new Set<string>();
  const socialProfiles = all.filter((f) => {
    if (f.source !== 'search' || !f.url) return false;
    if (!/(?:instagram|facebook|tiktok|twitter|x|linkedin|threads)\.com\//i.test(f.url)) return false;
    if (socialSeen.has(f.url)) return false;
    socialSeen.add(f.url);
    return true;
  });
  const platformName = (url: string): string => {
    const m = /(instagram|facebook|tiktok|twitter|x|linkedin|threads)\.com/i.exec(url);
    const p = m?.[1]?.toLowerCase();
    return p === 'x' ? 'X/Twitter' : p ? p[0]!.toUpperCase() + p.slice(1) : 'Profile';
  };

  // Bright Data pulls the actual public IG/TikTok profile (followers, bio).
  const socialContent = all.filter((f) => f.source === 'brightdata');

  if (socialProfiles.length || socialContent.length) {
    const sp = ['🩷 <b>Social media</b>', ''];
    for (const f of socialContent) {
      sp.push(`<b>${escapeHtml(f.title)}</b>`);
      if (f.detail) for (const line of f.detail.split('\n')) sp.push(escapeHtml(line));
      sp.push('');
    }
    for (const f of socialProfiles.slice(0, 8)) {
      sp.push(`• <b>${escapeHtml(platformName(f.url!))}:</b> <a href="${escapeHtml(f.url!)}">${escapeHtml(f.title)}</a>`);
    }
    sections.push(sp.join('\n'));
  }

  if (strong.length || weak.length) {
    const acct = ['📱 <b>Other accounts under this handle</b>'];
    if (strong.length) {
      acct.push('', '✅ <b>Very likely him:</b>');
      for (const f of strong) acct.push(`• <a href="${escapeHtml(f.url!)}">${escapeHtml(acctText(f))}</a>`);
    }
    if (weak.length) {
      acct.push('', '🤔 <b>Same username — could be someone else:</b>');
      for (const f of weak.slice(0, 15)) acct.push(`• <a href="${escapeHtml(f.url!)}">${escapeHtml(acctText(f))}</a>`);
    }
    acct.push('', '<i>💡 Same username ≠ same person, babe. Check the profile pics match before you trust it.</i>');
    sections.push(acct.join('\n'));
  }

  // ── 4. Public records & web mentions (the meat of a name search) ─────────
  const recSeen = new Set<string>();
  const records = all.filter((f) => {
    if (!['nppes', 'sec', 'courtlistener', 'search', 'fec', 'opencorporates', 'finra', 'wikipedia', 'academic'].includes(f.source))
      return false;
    const key = f.url ?? f.title;
    if (recSeen.has(key)) return false;
    recSeen.add(key);
    return true;
  });
  if (records.length) {
    // FEC (job/employer/money/politics) and businesses are high-signal — lead with them.
    records.sort((a, b) => {
      const rank = (s: string) => (s === 'fec' ? 0 : s === 'opencorporates' ? 1 : s === 'sec' || s === 'nppes' ? 2 : 3);
      return rank(a.source) - rank(b.source);
    });
    const rec = ['📄 <b>Public records &amp; mentions</b>', ''];
    for (const f of records.slice(0, 10)) {
      rec.push(f.url ? `• <a href="${escapeHtml(f.url)}">${escapeHtml(f.title)}</a>` : `• ${escapeHtml(f.title)}`);
      const first = f.detail?.split('\n')[0];
      if (first && f.source !== 'search') rec.push(`  <i>${escapeHtml(first)}</i>`);
    }
    sections.push(rec.join('\n'));
  }

  // ── 4.5 Hidden accounts & breaches (incl. dating-app signal) ─────────────
  const breaches = all.filter((f) => f.source === 'hibp');
  if (breaches.length) {
    const b = ['🔓 <b>Hidden accounts &amp; leaks</b>', ''];
    for (const f of breaches) {
      b.push(`<b>${escapeHtml(f.title)}</b>`);
      if (f.detail) for (const line of f.detail.split('\n')) b.push(escapeHtml(line));
    }
    b.push('', '<i>💡 A dating/adult site here means he had an account there. Leaks also reveal accounts he never mentioned.</i>');
    sections.push(b.join('\n'));
  }

  // ── 5. Contact traces: phone, linked emails & personal sites ─────────────
  const contact: string[] = [];
  for (const f of all.filter((f) => f.source === 'phone')) {
    contact.push(`• ${escapeHtml(f.title)}`);
    const first = f.detail?.split('\n')[0];
    if (first) contact.push(`  <i>${escapeHtml(first)}</i>`);
  }
  for (const e of graph.nodes.filter((n) => n.depth > 0 && n.kind === 'email')) {
    contact.push(`• 📧 Email linked to him: ${escapeHtml(e.value)}`);
  }
  for (const d of graph.nodes.filter((n) => n.depth > 0 && n.kind === 'domain')) {
    contact.push(`• 🌐 Website linked to him: ${escapeHtml(d.value)}`);
  }
  if (contact.length) sections.push(['📇 <b>Contact traces</b>', '', ...contact].join('\n'));

  // ── 6. Old / deleted profiles (the archive superpower) ───────────────────
  const archived = all.filter((f) => f.source === 'wayback' && /archiv/i.test(`${f.label} ${f.title}`));
  if (archived.length) {
    const a = ['🕰️ <b>Old or deleted profiles</b>', '<i>these existed before — even if they’re gone now 👀</i>', ''];
    for (const f of archived.slice(0, 8)) a.push(`• ${escapeHtml(f.title)}`);
    sections.push(a.join('\n'));
  }

  // ── "Want deeper?" — nudge for the selectors we don't have yet ───────────
  const nudges: string[] = [];
  const haveEmail =
    seed.kind === 'email' ||
    graph.nodes.some((n) => n.kind === 'email') ||
    all.some((f) => f.source === 'enformion' && f.label === 'Emails');
  const havePhone =
    seed.kind === 'phone' ||
    all.some((f) => f.source === 'phone') ||
    all.some((f) => f.source === 'enformion' && f.label === 'Phones');
  if (!haveEmail) nudges.push('📧 his <b>email</b> — finds more accounts + breach checks');
  if (!havePhone) nudges.push('📱 his <b>phone</b> — tells you the real registered name');
  nudges.push('📸 his <b>photo</b> (as a File) — catches catfish + stolen pics');
  sections.push(['💌 <b>Want me to dig deeper?</b> Send me:', '', ...nudges].join('\n'));

  // ── 9. Footer ────────────────────────────────────────────────────────────
  sections.push(`🔔 Want me to keep tabs on him 24/7? Send  <code>/watch ${escapeHtml(seed.raw)}</code> 💖`);

  return chunk(sections);
}

/**
 * Clean, girly render for a photo check. Leads with the two things that actually
 * matter to a non-technical reader — is it a fake/AI image, and does the face
 * turn up elsewhere — and drops the raw SHA/dimensions dump into a small footer.
 */
export function renderImageReport(findings: Finding[]): string[] {
  const by = (labels: string[]) => findings.filter((f) => labels.includes(f.label));
  const lines: string[] = ['📸 <b>Photo check</b>', ''];

  const ai = by(['Synthetic media']);
  const c2pa = by(['C2PA']);
  const gps = by(['GPS']);
  const reverse = findings.filter((f) => f.source === 'reverse');
  const exif = by(['EXIF']);

  // Headline verdict.
  if (ai.length) {
    lines.push('🔴 <b>This image looks AI-generated or edited.</b>', '<i>Metadata names an AI tool — be very skeptical of these photos.</i>', '');
  } else {
    lines.push('🟢 No obvious sign the image itself is faked.', '');
  }

  if (reverse.length) {
    lines.push('🔎 <b>Where this face shows up</b>');
    for (const f of reverse) {
      if (f.url) lines.push(`• <a href="${escapeHtml(f.url)}">${escapeHtml(f.title)}</a>`);
      else {
        lines.push(escapeHtml(f.title));
        if (f.detail) lines.push(`<i>${escapeHtml(f.detail)}</i>`);
      }
    }
    lines.push('');
  }

  if (gps.length) {
    const g = gps[0]!;
    lines.push(`📍 <b>Location baked into the photo:</b> ${escapeHtml(g.title.replace(/^Geotagged:\s*/, ''))}`);
    if (g.url) lines.push(`<a href="${escapeHtml(g.url)}">Open in Maps</a>`);
    lines.push('');
  }

  if (c2pa.length) lines.push('🏷️ Has Content Credentials (C2PA) — check contentcredentials.org/verify.', '');

  // Small, non-scary technical footer.
  const foot: string[] = [];
  if (exif.length && exif[0]!.detail) {
    const cam = exif[0]!.detail!.split('\n').find((l) => /^Camera:|^Software:/.test(l));
    if (cam) foot.push(`<i>${escapeHtml(cam)}</i>`);
  } else if (!ai.length) {
    foot.push('<i>No camera metadata (normal for anything downloaded from social media).</i>');
  }
  if (foot.length) lines.push(...foot);

  lines.push('', '<i>💡 The real test: do these match the photos of whoever you’ve been talking to?</i>');

  return chunk([lines.join('\n')]);
}

/**
 * Render the full dossier: deterministic signals first (they are the safety
 * payload and must never be buried), then the AI narrative, clearly labelled as
 * interpretation so the reader keeps facts and analysis separate.
 */
export function renderDossier(seed: Subject, dossier: Dossier): string[] {
  const lines: string[] = [`<b>Dossier — ${escapeHtml(seed.raw)}</b>`, ''];

  if (dossier.signals.length) {
    lines.push('<b>Signals</b>');
    // Most severe first so a red flag is never below an info line.
    const order = { red: 0, amber: 1, info: 2 };
    for (const s of [...dossier.signals].sort((a, b) => order[a.level] - order[b.level])) {
      lines.push(`${SIGNAL_ICON[s.level]} ${escapeHtml(s.text)}`);
    }
    lines.push('');
  } else {
    lines.push('<i>No automated red flags.</i>', '');
  }

  if (dossier.narrative) {
    lines.push('<b>Assessment</b> <i>(AI interpretation of the findings)</i>');
    lines.push(escapeHtml(dossier.narrative));
  } else {
    lines.push('<i>Narrative unavailable (no ANTHROPIC_API_KEY, or nothing found). Raw findings above stand on their own.</i>');
  }

  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > TELEGRAM_LIMIT) {
      chunks.push(cur);
      cur = line;
    } else {
      cur += (cur ? '\n' : '') + line;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/**
 * Render the identity graph as a readable tree: seed first, then each pivot
 * indented under the node it was discovered from, with the reason for the link.
 * Confidence is shown so a third-hop guess never reads as an established fact.
 */
export function renderGraph(result: GraphResult): string[] {
  const byParent = new Map<string, typeof result.nodes>();
  for (const node of result.nodes) {
    const parent = node.via?.fromId ?? '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(node);
  }

  const lines: string[] = [];
  const seed = result.nodes.find((n) => n.id === result.seedId)!;
  const strongHits = (n: (typeof result.nodes)[number]) =>
    n.findings.filter((f) => f.confidence >= 0.7).length;

  lines.push(`<b>Identity graph — ${escapeHtml(seed.value)}</b>`);
  lines.push(`${result.nodes.length} linked selectors${result.truncated ? ' (capped)' : ''}`);
  lines.push('');

  const walk = (id: string, indent: number): void => {
    const children = byParent.get(id) ?? [];
    for (const node of children) {
      const pad = '  '.repeat(indent);
      const conf = node.confidence >= 0.75 ? '' : ` <i>~${Math.round(node.confidence * 100)}%</i>`;
      lines.push(`${pad}└ <b>${escapeHtml(node.kind)}</b>: ${escapeHtml(node.value)}${conf}`);
      if (node.via) lines.push(`${pad}   <i>${escapeHtml(node.via.reason)}</i>`);
      const hits = strongHits(node);
      if (hits) lines.push(`${pad}   ${hits} confirmed finding${hits === 1 ? '' : 's'}`);
      walk(node.id, indent + 1);
    }
  };

  lines.push(`● <b>${escapeHtml(seed.kind)}</b>: ${escapeHtml(seed.value)} — ${strongHits(seed)} findings`);
  walk(result.seedId, 1);

  // Chunk to Telegram's limit on line boundaries.
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > TELEGRAM_LIMIT) {
      chunks.push(cur);
      cur = line;
    } else {
      cur += (cur ? '\n' : '') + line;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/**
 * Optional narrative pass. The raw findings are always shown — this only adds an
 * interpretation on top, and is explicitly told not to invent anything, because a
 * confident-sounding fabrication about a real person is the worst failure mode
 * this product has.
 */
export async function synthesize(
  subject: Subject,
  results: SourceResult[],
): Promise<string | null> {
  if (!config.anthropicKey) return null;

  const findings = results.flatMap((r) => r.findings);
  if (findings.length === 0) return null;

  const client = new Anthropic({ apiKey: config.anthropicKey });

  const payload = findings.map((f) => ({
    source: f.label,
    title: f.title,
    detail: f.detail,
    url: f.url,
    confidence: f.confidence,
  }));

  const msg = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 900,
    system: [
      'You summarise OSINT findings for an investigator.',
      'Rules:',
      '- Use ONLY the supplied findings. Never add outside knowledge about the subject.',
      '- Say plainly when findings likely describe different people; do not merge identities.',
      '- Flag contradictions and note what is missing.',
      '- Findings with confidence below 0.5 must be described as unconfirmed.',
      '- No speculation about protected characteristics, health, finances or criminal history.',
      '- Plain prose, under 200 words, no headings, no markdown.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: `Subject: ${subject.raw} (type: ${subject.kind})\n\nFindings JSON:\n${JSON.stringify(payload, null, 1)}`,
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
