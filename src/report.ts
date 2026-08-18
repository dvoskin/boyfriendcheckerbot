import Anthropic from '@anthropic-ai/sdk';
import { config } from './core/config.js';
import type { Dossier } from './core/dossier.js';
import type { GraphResult } from './core/graph.js';
import type { Finding, SourceResult, Subject } from './core/types.js';
import { REVEAL, type RevealKey } from './core/wallet.js';

const TELEGRAM_LIMIT = 4096;

/** One paywalled section of a report — revealed when the user spends tokens. */
export interface LockedSection {
  key: RevealKey;
  label: string; // button text
  cost: number;
  chunks: string[]; // the section content, pre-chunked for Telegram
}

/** The at-a-glance data behind the verdict — used to draw the shareable card. */
export interface ReportSummary {
  name: string;
  verdict: string; // e.g. "PROCEED WITH CAUTION"
  score: number; // 0–100
  red: number;
  green: number;
  redLabels: string[]; // the actual red-flag lines (for the card + previews)
  greenLabels: string[];
}

/** A report split into the free verdict and the paywalled reveals. */
export interface ReportParts {
  free: string[]; // verdict card (+ thin nudge) — always shown
  locked: LockedSection[]; // the juicy sections, behind token unlocks
  thin: boolean; // true when we found almost nothing (skip the paywall)
  summary: ReportSummary; // for the shareable card
}

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
export function renderReportParts(seed: Subject, graph: GraphResult, dossier: Dossier): ReportParts {
  const all = graph.nodes.flatMap((n) => n.findings);
  const free: string[] = [];

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

  // ── Vibe check: a single 0–100 score, computed deterministically ─────────
  // A shareable "how much should I worry" number. Starts at 100 and drops for
  // real safety signals — never for neutral facts.
  let score = 100;
  const anyF = (pred: (f: (typeof all)[number]) => boolean) => all.some(pred);
  if (anyF((f) => f.source === 'ofac')) score -= 45;
  if (anyF((f) => f.source === 'registry' && /🔴/.test(f.title))) score -= 45;
  if (anyF((f) => f.source === 'adverse' && /🚨/.test(f.title))) score -= 30;
  if (anyF((f) => f.source === 'scam' && /🚨/.test(f.title))) score -= 30;
  if (anyF((f) => f.source === 'unicourt' && /🔴/.test(f.title))) score -= 25;
  if (anyF((f) => f.source === 'criminal' && /🔴/.test(f.title))) score -= 20;
  if (anyF((f) => f.source === 'ipqs' && /🔴/.test(f.title))) score -= 18;
  if (anyF((f) => f.source === 'emailrep' && /🔴/.test(f.title))) score -= 15;
  if (anyF((f) => f.source === 'enformion' && f.label === 'Criminal record')) score -= 25;
  if (anyF((f) => f.label === 'Synthetic media')) score -= 20;
  if (anyF((f) => f.source === 'hibp' && /DATING|ADULT/i.test(f.title))) score -= 15;
  if (anyF((f) => f.source === 'finra' && /🔴/.test(f.title))) score -= 10;
  const relForScore = all.find((f) => f.source === 'enformion' && f.label === 'Relationship status')?.extra?.status;
  if (relForScore === 'married') score -= 30;
  else if (relForScore === 'divorced') score -= 5;
  score -= dossier.signals.filter((s) => s.level === 'amber').length * 4;
  if (dossier.signals.some((s) => /thin or freshly/i.test(s.text))) score -= 8;
  score = Math.max(3, Math.min(100, score));

  // Data richness — a no-data person must NOT read as "looking good" (that implies
  // we checked and they're safe; really we just found nothing).
  const hasDeep = all.some((f) => f.source === 'enformion' && f.label === 'Identity');
  const confirmedAccts = all.filter((f) => f.confidence >= 0.7 && ['usernames', 'github', 'bluesky'].includes(f.source)).length;
  const hasRecords = all.some(
    (f) => ['sec', 'nppes', 'fec', 'finra', 'courtlistener', 'wikipedia', 'academic', 'opencorporates'].includes(f.source) && f.confidence >= 0.5,
  );
  const hasBreach = all.some((f) => f.source === 'hibp' && /breach/i.test(f.title));
  const hasRedFlag = redFlagCount > 0 || all.some((f) => f.source === 'registry' && /🔴/.test(f.title));
  const thin = !hasDeep && confirmedAccts < 2 && !hasRecords && !hasBreach && !hasRedFlag;

  const vibe = thin
    ? '🤷 not enough info yet'
    : score >= 75
      ? '🟢 looking good'
      : score >= 45
        ? '🟡 a few yellow flags'
        : '🔴 serious red flags';

  // ── The VERDICT + flag scoreboard — the screenshottable heart of the report.
  // Verdict-first because that's what the user screenshots and drops in the group chat.
  const verdict = thin
    ? '🤷 NOT ENOUGH TO CALL IT'
    : score >= 75
      ? '💚 LOOKING GREEN'
      : score >= 45
        ? '⚠️ PROCEED WITH CAUTION'
        : '🚩 MAJOR RED FLAGS';

  // A 10-block meter bar so the score reads at a glance, screenshot or not.
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  const meter = '█'.repeat(filled) + '░'.repeat(10 - filled);

  // Build the two columns from REAL evidence only. Green flags are never asserted
  // from absence ("nothing found" ≠ "he's safe") — only from positive confirmation.
  const red: string[] = [];
  const green: string[] = [];
  if (anyF((f) => f.source === 'ofac')) red.push('On a sanctions / watchlist 🚨');
  if (anyF((f) => f.source === 'registry' && /🔴/.test(f.title))) red.push('Sex-offender registry match');
  if (anyF((f) => f.source === 'adverse' && /🚨/.test(f.title))) red.push('Arrest / lawsuit / scandal in the news');
  if (anyF((f) => f.source === 'scam' && /🚨/.test(f.title))) red.push('Shows up in scam / fraud complaints');
  if (
    anyF((f) => (f.source === 'unicourt' || f.source === 'criminal') && /🔴/.test(f.title)) ||
    anyF((f) => f.source === 'enformion' && f.label === 'Criminal record')
  )
    red.push('Court / criminal record on file');
  if (relStatus === 'married') red.push('💍 Marriage record — may NOT be single');
  if (anyF((f) => f.label === 'Synthetic media')) red.push('Photos may be AI-generated 🤖');
  if (anyF((f) => f.source === 'hibp' && /DATING|ADULT/i.test(f.title))) red.push('Account on a dating / adult site');
  if (anyF((f) => (f.source === 'ipqs' || f.source === 'emailrep') && /🔴/.test(f.title))) red.push('Email/phone looks risky (burner/fraud)');

  if (hasDeep && relStatus !== 'married' && relStatus !== 'divorced') green.push('No marriage record — looks single 💚');
  if (hasDeep) green.push('Identity matches public records ✅');
  if (confirmedAccts >= 2) green.push('Real, established online footprint');
  if (employer || occupation) green.push('Job / employer checks out 💼');
  if (age) green.push('Age lines up with the records');
  if (!red.length && !thin && green.length) green.push('Nothing scary jumped out ✨');

  const card = [
    '♟️ <b>CHECKMATE</b>  ·  <i>here’s the full read</i>',
    '━━━━━━━━━━━━━━━',
    `🎯 <b>${escapeHtml(seed.raw)}</b>`,
    '',
    `<b>${verdict}</b>`,
    `💯 <code>${meter}</code> ${score}/100`,
    '',
  ];
  // At-a-glance facts, right under the verdict.
  const facts: string[] = [];
  if (age) facts.push(`🎂 <b>Age:</b> ${escapeHtml(age)}`);
  if (city) facts.push(`📍 <b>Lives:</b> ${escapeHtml(city)}`);
  if (relStatus) {
    const rel = relStatus === 'married' ? '💍 Married — careful!' : relStatus === 'divorced' ? '💔 Divorced' : '💚 No marriage record (looks single)';
    facts.push(`💘 <b>Status:</b> ${rel}`);
  }
  if (employer || occupation) facts.push(`💼 <b>Works:</b> ${escapeHtml([occupation, employer].filter(Boolean).join(' @ '))}`);
  if (facts.length) card.push(...facts, '');

  // The scoreboard — two columns, emoji-led, built to screenshot.
  card.push(`🚩 <b>RED FLAGS (${red.length})</b>`);
  if (red.length) for (const r of red) card.push(`   • ${r}`);
  else card.push('   <i>· none so far</i>');
  card.push('', `💚 <b>GREEN FLAGS (${green.length})</b>`);
  if (green.length) for (const g of green) card.push(`   • ${g}`);
  else card.push('   <i>· none confirmed yet</i>');

  card.push('', '📸 <i>screenshot this before your next move</i>');
  free.push(card.join('\n'));

  // ── "Who is this number?" card — free, phone searches only ───────────────
  // Reverse-number lookup is the highest-frequency habit in the category, so the
  // caller-ID answer (registered name, line type, burner/scam flag) is up front.
  if (seed.kind === 'phone') {
    const phoneF = all.filter((f) => f.source === 'phone');
    const reg = phoneF.find((f) => f.extra?.registeredName)?.extra?.registeredName as string | undefined;
    const lineType = phoneF.find((f) => f.extra?.lineType)?.extra?.lineType as string | undefined;
    const carrier = phoneF
      .map((f) => (f.detail ?? '').split('\n').find((l) => /^Carrier:/i.test(l)))
      .find(Boolean)
      ?.replace(/^Carrier:\s*/i, '');
    const voip = phoneF.some((f) => /voip/i.test(f.title));
    const fraud = all.find((f) => f.source === 'ipqs' && /phone/i.test(f.label));
    const fraudRisky = fraud && /🔴|risk|fraud|voip|disposable|recent abuse/i.test(fraud.title);

    const pc = ['📞 <b>WHO IS THIS NUMBER?</b>', ''];
    pc.push(reg ? `🪪 <b>Registered to:</b> ${escapeHtml(reg)}` : '🪪 <b>Registered name:</b> <i>not published (unlisted)</i>');
    if (lineType) pc.push(`📶 <b>Line:</b> ${escapeHtml(lineType)}${voip ? ' — ⚠️ VoIP / internet number' : ''}`);
    if (carrier) pc.push(`🏢 <b>Carrier:</b> ${escapeHtml(carrier)}`);
    if (fraud) pc.push(`${fraudRisky ? '🚩' : '✅'} <b>Scam check:</b> ${escapeHtml(fraud.title.replace(/^📱\s*/, ''))}`);
    if (voip && !fraudRisky) pc.push('', '<i>💡 VoIP numbers are common for burners and people hiding their real line.</i>');
    if (!reg && !lineType && !carrier && !fraud) {
      pc.push('', '<i>Couldn’t pull carrier data on this one — try their name or email for more.</i>');
    }
    free.push(pc.join('\n'));
  }

  // ── Thin-footprint callout — turn an empty result into a next step ───────
  if (thin) {
    const tips: string[] = ['⚠️ <b>Not much came back on this one.</b>', 'For a fuller report, give me a sharper lead:', ''];
    if (seed.kind === 'person') tips.push('📍 add a <b>city</b>  (tap 🔍 and send  <code>John Smith | Miami</code>)');
    tips.push('💬 their <b>@username</b> — best for socials');
    tips.push('📧 their <b>email</b> — hidden accounts + breaches');
    tips.push('📸 their <b>photo</b> — catfish check');
    tips.push('', '<i>Common names with no city come back thin — that’s how public records work, not a miss. 💛</i>');
    free.push(tips.join('\n'));
  }

  // ── Build the four paywalled buckets. Each is only offered if it has data. ──
  const locked: LockedSection[] = [];

  // ☕ THE TEA — the AI honest read.
  if (dossier.narrative) {
    locked.push({
      key: 'tea',
      label: `☕ The full tea`,
      cost: REVEAL.tea,
      chunks: chunk([`☕ <b>THE TEA</b> — <i>what it all actually means</i>\n\n${escapeHtml(dossier.narrative)}`]),
    });
  }

  // 🛡️ SAFETY — the highest-stakes bucket: criminal/court/registry/sanctions/scam.
  const safety = all.filter(
    (f) =>
      ['registry', 'ofac', 'adverse', 'scam', 'unicourt', 'criminal', 'ipqs', 'emailrep'].includes(f.source) ||
      (f.source === 'enformion' && f.label === 'Criminal record'),
  );
  if (safety.length) {
    safety.sort((a, b) => b.confidence - a.confidence);
    const s = ['🛡️ <b>Safety check</b>', ''];
    for (const f of safety) {
      s.push(f.url ? `• <a href="${escapeHtml(f.url)}">${escapeHtml(f.title)}</a>` : `• ${escapeHtml(f.title)}`);
      const first = f.detail?.split('\n')[0];
      if (first) s.push(`  <i>${escapeHtml(first)}</i>`);
    }
    locked.push({ key: 'safety', label: '🛡️ Safety & records', cost: REVEAL.safety, chunks: chunk([s.join('\n')]) });
  }

  // 💍 SINGLE & THE REAL THEM — relationship + relatives/addresses + job/business/records.
  const singleBlocks: string[] = [];
  const deep = all.filter((f) => (f.source === 'enformion' && f.label !== 'Criminal record') || f.source === 'spokeo');
  if (deep.length) {
    const d = ['💍 <b>Single or taken? The real them</b>', ''];
    for (const f of deep) {
      d.push(`<b>${escapeHtml(f.title)}</b>`);
      if (f.detail) for (const line of f.detail.split('\n')) d.push(escapeHtml(line));
      d.push('');
    }
    d.push('<i>💡 Public-records data — powerful but not perfect. Double-check it’s the right person (age + city).</i>');
    singleBlocks.push(d.join('\n'));
  }
  const recSeen = new Set<string>();
  const records = all.filter((f) => {
    if (
      !['nppes', 'sec', 'courtlistener', 'search', 'fec', 'opencorporates', 'finra', 'wikipedia', 'academic', 'gravatar', 'pipl'].includes(
        f.source,
      )
    )
      return false;
    const key = f.url ?? f.title;
    if (recSeen.has(key)) return false;
    recSeen.add(key);
    return true;
  });
  if (records.length) {
    records.sort((a, b) => {
      const rank = (s: string) => (s === 'fec' ? 0 : s === 'opencorporates' ? 1 : s === 'sec' || s === 'nppes' ? 2 : 3);
      return rank(a.source) - rank(b.source);
    });
    const rec = ['📄 <b>Job, money &amp; public records</b>', ''];
    for (const f of records.slice(0, 10)) {
      rec.push(f.url ? `• <a href="${escapeHtml(f.url)}">${escapeHtml(f.title)}</a>` : `• ${escapeHtml(f.title)}`);
      const first = f.detail?.split('\n')[0];
      if (first && f.source !== 'search') rec.push(`  <i>${escapeHtml(first)}</i>`);
    }
    singleBlocks.push(rec.join('\n'));
  }
  if (singleBlocks.length) {
    locked.push({ key: 'single', label: '💍 Single or taken?', cost: REVEAL.single, chunks: chunk(singleBlocks) });
  }

  // 🩷 SOCIALS & HIDDEN ACCOUNTS — profiles, same-handle accounts, breaches, archives.
  const socialBlocks: string[] = [];
  const acctText = (f: (typeof all)[number]): string => (f.source === 'usernames' ? f.label : `${f.label} ${f.title}`);
  const seen = new Set<string>();
  const social = all.filter((f) => {
    if (!f.url || !['usernames', 'github', 'bluesky'].includes(f.source)) return false;
    if (f.confidence < 0.5) return false;
    if (seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });
  const strong = social.filter((f) => f.confidence >= 0.7);
  const weak = social.filter((f) => f.confidence < 0.7);
  const socialSeen = new Set<string>();
  const socialProfiles = all.filter((f) => {
    if (f.source !== 'search' || !f.url) return false;
    if (!/(?<!\w)(?:instagram|facebook|tiktok|twitter|x|linkedin|threads)\.com\//i.test(f.url)) return false;
    if (socialSeen.has(f.url)) return false;
    socialSeen.add(f.url);
    return true;
  });
  const platformName = (url: string): string => {
    const m = /(?<!\w)(instagram|facebook|tiktok|twitter|x|linkedin|threads)\.com/i.exec(url);
    const p = m?.[1]?.toLowerCase();
    return p === 'x' ? 'X/Twitter' : p ? p[0]!.toUpperCase() + p.slice(1) : 'Profile';
  };
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
    socialBlocks.push(sp.join('\n'));
  }
  if (strong.length || weak.length) {
    const acct = ['📱 <b>Other accounts under this handle</b>'];
    if (strong.length) {
      acct.push('', '✅ <b>Very likely them:</b>');
      for (const f of strong) acct.push(`• <a href="${escapeHtml(f.url!)}">${escapeHtml(acctText(f))}</a>`);
    }
    if (weak.length) {
      acct.push('', '🤔 <b>Same username — could be someone else:</b>');
      for (const f of weak.slice(0, 15)) acct.push(`• <a href="${escapeHtml(f.url!)}">${escapeHtml(acctText(f))}</a>`);
    }
    acct.push('', '<i>💡 Same username ≠ same person. Check the profile pics match before you trust it.</i>');
    socialBlocks.push(acct.join('\n'));
  }
  const breaches = all.filter((f) => f.source === 'hibp');
  if (breaches.length) {
    const b = ['🔓 <b>Hidden accounts &amp; leaks</b>', ''];
    for (const f of breaches) {
      b.push(`<b>${escapeHtml(f.title)}</b>`);
      if (f.detail) for (const line of f.detail.split('\n')) b.push(escapeHtml(line));
    }
    b.push('', '<i>💡 A dating/adult site here means they had an account there. Leaks also reveal accounts they never mentioned.</i>');
    socialBlocks.push(b.join('\n'));
  }
  const contact: string[] = [];
  const enfEmails = new Set(
    all
      .filter((f) => f.source === 'enformion' && f.label === 'Emails')
      .flatMap((f) => (f.detail ?? '').split('\n'))
      .map((s) => s.trim().toLowerCase()),
  );
  for (const e of graph.nodes.filter((n) => n.depth > 0 && n.kind === 'email')) {
    if (enfEmails.has(e.value.toLowerCase())) continue;
    contact.push(`• 📧 Email linked to them: ${escapeHtml(e.value)}`);
  }
  for (const d of graph.nodes.filter((n) => n.depth > 0 && n.kind === 'domain')) {
    contact.push(`• 🌐 Website linked to them: ${escapeHtml(d.value)}`);
  }
  if (contact.length) socialBlocks.push(['📇 <b>Contact traces</b>', '', ...contact].join('\n'));
  const archived = all.filter((f) => f.source === 'wayback' && /archiv/i.test(`${f.label} ${f.title}`));
  if (archived.length) {
    const a = ['🕰️ <b>Old or deleted profiles</b>', '<i>these existed before — even if they’re gone now 👀</i>', ''];
    for (const f of archived.slice(0, 8)) a.push(`• ${escapeHtml(f.title)}`);
    socialBlocks.push(a.join('\n'));
  }
  if (socialBlocks.length) {
    locked.push({ key: 'social', label: '🩷 Socials & hidden accounts', cost: REVEAL.social, chunks: chunk(socialBlocks) });
  }

  // Keep the safety bucket first (highest stakes), then single, social, tea.
  const order: RevealKey[] = ['safety', 'single', 'social', 'tea'];
  locked.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  // Strip emoji from flag labels for the card (bundled font has no color emoji).
  const plain = (s: string) => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();
  const summary: ReportSummary = {
    name: seed.raw,
    verdict: verdict.replace(/^[^A-Z]*/, ''), // drop the leading emoji for the card
    score,
    red: red.length,
    green: green.length,
    redLabels: red.map(plain),
    greenLabels: green.map(plain),
  };
  return { free, locked, thin, summary };
}

/** Legacy full-report render (everything concatenated) — kept for any caller. */
export function renderReport(seed: Subject, graph: GraphResult, dossier: Dossier): string[] {
  const p = renderReportParts(seed, graph, dossier);
  return [...p.free, ...p.locked.flatMap((l) => l.chunks)];
}

/**
 * Which "dig deeper" selectors we don't already have for this subject — used to
 * decide which enrichment buttons to show under the report.
 */
export function missingSelectors(seed: Subject, graph: GraphResult): { email: boolean; phone: boolean } {
  const all = graph.nodes.flatMap((n) => n.findings);
  const haveEmail =
    seed.kind === 'email' ||
    graph.nodes.some((n) => n.kind === 'email') ||
    all.some((f) => f.source === 'enformion' && f.label === 'Emails');
  const havePhone =
    seed.kind === 'phone' ||
    all.some((f) => f.source === 'phone') ||
    all.some((f) => f.source === 'enformion' && f.label === 'Phones');
  return { email: !haveEmail, phone: !havePhone };
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
