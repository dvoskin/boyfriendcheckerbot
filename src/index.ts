import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bot, type Context, InlineKeyboard, InputFile } from 'grammy';
import { audit } from './core/audit.js';
import { config, requireBotToken } from './core/config.js';
import { runSources } from './core/runner.js';
import type { SourceResult, Subject, SubjectKind } from './core/types.js';
import { analyzeImage } from './media/provenance.js';
import { reverseImageSearch } from './media/reverse.js';
import { analyzeScreenshot, type ImageMime } from './media/screenshot.js';
import { spentToday } from './core/budget.js';
import { writeDossier } from './core/dossier.js';
import { addFlag, addLabel, type FlagCategory, FLAG_LABELS, lookupFlags, recentFlags, subjectKeys } from './core/flags.js';
import { checkStats, recordSearch, searchersOf } from './core/searchers.js';
import { hasOptedIn, optIn } from './core/match.js';
import { badgeFor, claimProfile, myProfile, setBadgePaid, verifiedOwnerFor } from './core/profiles.js';
import { addTokens, applyReferral, balanceOf, claimDaily, COST, grantStarter, inviteCount, isFree, type RevealKey, spend, TOKEN_PACKS, TOKENS } from './core/wallet.js';
import { buildGraph } from './core/graph.js';
import { addWatch, allWatches, listWatches, removeWatch, updateBaseline } from './core/watch.js';
import { escapeHtml, type LockedSection, missingSelectors, renderFindings, renderGraph, renderImageReport, renderProgress, renderReportParts, type ReportSummary, synthesize } from './report.js';
import { renderCardPng } from './media/card.js';
import { generateDateQuestions } from './core/predate.js';
import { analyzeScamText } from './core/scamtext.js';
import { type Candidate, enformionCandidates } from './sources/enformion.js';
import { ALL_SOURCES } from './sources/index.js';
import { warmOfac } from './sources/ofac.js';

/** Users mid-disambiguation: they were shown a numbered list and owe us a pick. */
const pendingPick = new Map<number, { candidates: Candidate[]; raw: string }>();

/** Users who tapped a menu button: their next message is this exact kind. */
const pendingInput = new Map<number, SubjectKind>();

/** Users we asked "what city?" — their next message is the city for this name. */
const pendingCity = new Map<number, string>();

/** The last person each user searched — so a "🚩 Flag" tap knows who to flag. */
const lastSearched = new Map<
  number,
  { seed: Subject; keys: string[]; locked?: LockedSection[]; unlocked?: Set<RevealKey>; summary?: ReportSummary; narrative?: string }
>();

/** Users we asked "how do you know them?" — their next message is the label. */
const pendingLabel = new Set<number>();

/** Users composing an anonymous note to another matched user (relay target id). */
const pendingRelay = new Map<number, number>();

/** Users who tapped "read a screenshot" — their next image is AI-analysed, not catfish-checked. */
const pendingScreenshot = new Set<number>();

/** Users claiming their own profile — their next message is their own name. */
const pendingVerify = new Set<number>();

/** Users who tapped "Is this a scam?" — their next message is the text to judge. */
const pendingScam = new Set<number>();

/** Stars price (⭐) for 30 days of the ✅ Verified badge — the second-audience revenue. */
const BADGE_STARS = 599;

/** The bot's @username, for building referral links. Set at startup. */
let botUsername = 'YourCheckmateBot';

/** Out-of-tokens prompt with the ways to earn more (the retention loop). */
async function earnMore(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard()
    .text('🎁 Daily reward', 'daily')
    .text('👯 Invite friends', 'invite')
    .row()
    .text('💎 Buy tokens', 'buy');
  await ctx.reply(
    [
      '💸 <b>Out of tokens!</b>',
      '',
      'Grab more — it’s easy:',
      `🎁 <b>Daily reward</b> — come back every day for free tokens (streaks give bonuses!)`,
      `👯 <b>Invite friends</b> — you both get tokens`,
      `💎 <b>Buy a pack</b> — instant top-up`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

/** The tap-to-choose input menu — removes the guesswork of free-text parsing. */
const mainMenu = new InlineKeyboard()
  .text('🧑 Name', 'ask:person')
  .text('💬 Username', 'ask:username')
  .row()
  .text('📧 Email', 'ask:email')
  .text('📱 Phone', 'ask:phone')
  .row()
  .text('📸 Photo', 'ask:image')
  .text('🧠 Read a screenshot', 'ask:screenshot')
  .row()
  .text('🕵️ Is this a scam?', 'scamcheck')
  .text('🧱 Red-flag wall', 'wall')
  .row()
  .text('✅ Verify yourself', 'verifyme')
  .row()
  .text('💎 My tokens', 'balance')
  .text('🎁 Free daily', 'daily')
  .text('👯 Invite', 'invite');

const ASK_PROMPT: Record<string, string> = {
  person: 'Send me their <b>full name</b> 🧑\n<i>Tip: add a city for a sharper match — <code>John Smith | Miami</code></i>',
  username: 'Send me their <b>@username</b> 💬  (Instagram, TikTok, etc.)',
  email: 'Send me their <b>email</b> 📧',
  phone: 'Send me the <b>phone number</b> 📱\n<i>I’ll tell you who it’s registered to, if it’s a burner/VoIP, and if it’s flagged for scams.</i>',
  image: 'Send me their <b>photo as a File 📎</b> (not compressed, so the hidden data survives).',
};

/** Force a specific kind (from a button) rather than guessing from the text. */
function seedForKind(kind: SubjectKind, text: string): Subject {
  const [value, hints] = text.split('|').map((s) => s.trim());
  const v = value ?? text;
  if (kind === 'phone') {
    const digits = v.replace(/[^\d+]/g, '');
    return { raw: v, kind: 'phone', value: digits };
  }
  return { raw: v, kind, value: v.replace(/^@/, ''), hints };
}

const CONSENT_FILE = () => join(config.dataDir, 'consent.json');
const consented = new Set<number>();

async function loadConsent(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    const raw = await readFile(CONSENT_FILE(), 'utf8');
    for (const id of JSON.parse(raw) as number[]) consented.add(id);
  } catch {
    // First run — no file yet.
  }
}

async function saveConsent(): Promise<void> {
  await writeFile(CONSENT_FILE(), JSON.stringify([...consented]), 'utf8');
}

const TERMS = [
  '👋 <b>Hey! Quick ground rules first — 10 seconds, promise.</b>',
  '',
  'I only dig through <b>public stuff</b> 🌐 — social profiles, public records, court &amp; ',
  'sanctions lists, the internet archive. No hacking, no leaks, no private DMs. If it’s ',
  'behind a login, I can’t (and won’t) touch it. 🙅‍♀️',
  '',
  'By tapping <b>/agree</b> you promise to use me for <b>your own safety &amp; peace of mind</b> — ',
  'NOT to:',
  '🚫 decide who to hire, rent to, or lend money to (that’s a different kind of report, and illegal here)',
  '🚫 stalk, harass, or scare anyone',
  '',
  '📝 Heads up: every search is logged. Be cool. 💅',
  '',
  '<b>Ready? Tap 👉 /agree</b>',
].join('\n');

const HELP = [
  '<b>You’re in! 🎉 Let’s see who they really are 👀</b>',
  '',
  'Just send me <b>anything you’ve got</b> — no commands, no fuss. I’ll figure it out:',
  '',
  '💬 their <b>@username</b>   →  like  <code>@johndoe</code>',
  '🧑 their <b>name</b>   →  like  <code>John Smith</code>',
  '📧 their <b>email</b>   →  like  <code>john@gmail.com</code>',
  '📱 their <b>phone</b>   →  like  <code>+1 305 555 0199</code>',
  '📸 their <b>photo</b>   →  send it as a <b>File 📎</b> (not compressed!) so the hidden data survives',
  '',
  'Then just wait ~15 sec while I dig. 🔍✨',
  '',
  '🔔 Want me to <b>keep watching</b> someone? Send <code>/watch @handle</code> and I’ll ping you when anything changes.',
  '   (see them with <code>/watchlist</code>, stop with <code>/unwatch</code>)',
  '',
  '💎 Each check spends a few <b>tokens</b>. Top up free anytime:',
  '   🎁 <code>/daily</code> — free tokens every day (streaks = bonuses!)',
  '   👯 <code>/invite</code> — you + your friend both get tokens',
  '   💰 <code>/balance</code> — see your tokens',
  '',
  '<i>Not sure? Just send their @ or their name and see. Try  torvalds  to test me. 😉</i>',
].join('\n');

/** Values that mean the user typed the placeholder instead of a real target. */
const PLACEHOLDER_VALUES = new Set(['handle', 'value', 'username', 'name', 'him', 'his', 'test']);

const NUDGE = [
  '🤔 Hmm, I need something to go on!',
  '',
  'Just send me their <b>@username</b>, <b>name</b>, <b>email</b>, <b>phone</b>, or a <b>photo</b> 📸 — ',
  'no slash needed. For example:  <code>@johndoe</code>  or  <code>John Smith</code>',
].join('\n');

/** Profile-page path segments that are never usernames. */
const NOT_HANDLE = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'share', 'about', 'home', 'i']);

/** Best-effort type detection so plain messages work without a command. */
function detectSubject(text: string): Subject {
  const raw = text.trim();
  const [beforePipe, afterPipe] = raw.split('|').map((s) => s.trim());
  const value = beforePipe ?? raw;
  const hints = afterPipe;

  // A pasted social profile URL → pull his handle out and search that. People
  // WILL paste "instagram.com/hisname" — without this it would choke.
  const social = /(?:instagram|tiktok|twitter|x|facebook|threads|pinterest|github)\.com\/@?([a-z0-9._-]{2,40})|(?:t\.me|telegram\.me)\/@?([a-z0-9._-]{2,40})|linkedin\.com\/in\/([a-z0-9-]{2,60})/i.exec(
    value,
  );
  const handle = social?.[1] ?? social?.[2] ?? social?.[3];
  if (handle && !NOT_HANDLE.has(handle.toLowerCase())) {
    return { raw: value, kind: 'username', value: handle.toLowerCase(), hints };
  }

  let kind: SubjectKind;
  if (/^@?[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) kind = 'email';
  else if (/^https?:\/\//i.test(value) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) kind = 'domain';
  else if (/^\+?[\d\s()-]{7,}$/.test(value)) kind = 'phone';
  else if (/\b(inc|llc|l\.l\.c|corp|ltd|co|pllc|pa|group|holdings)\b\.?$/i.test(value)) kind = 'company';
  else if (/\s/.test(value)) kind = 'person';
  else kind = 'username';

  return { raw: value, kind, value: value.replace(/^@/, ''), hints };
}

function guard(ctx: Context): boolean {
  const id = ctx.from?.id;
  if (!id) return false;
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(id)) {
    void ctx.reply('This bot is in private beta.');
    return false;
  }
  if (!consented.has(id)) {
    void ctx.reply(TERMS, { parse_mode: 'HTML' });
    return false;
  }
  return true;
}

async function handleLookup(ctx: Context, subject: Subject): Promise<void> {
  const applicable = ALL_SOURCES.filter((s) => s.accepts.includes(subject.kind));
  if (applicable.length === 0) {
    await ctx.reply(`No sources handle "${subject.kind}" yet.`);
    return;
  }

  const cost = COST[subject.kind as keyof typeof COST] ?? 10;
  if (!(await spend(ctx.from!.id, cost))) {
    await earnMore(ctx);
    return;
  }

  const status = await ctx.reply(renderProgress([], applicable.map((s) => s.label)), {
    parse_mode: 'HTML',
  });

  const done: SourceResult[] = [];
  let lastEdit = 0;
  let dirty = false;

  // Telegram throttles edits per chat, so coalesce updates instead of editing on
  // every single source completion.
  const flush = async (force = false): Promise<void> => {
    if (!dirty && !force) return;
    const now = Date.now();
    if (!force && now - lastEdit < 1500) return;
    lastEdit = now;
    dirty = false;
    const pending = applicable
      .filter((s) => !done.some((d) => d.source === s.id))
      .map((s) => s.label);
    try {
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        renderProgress(done, pending),
        { parse_mode: 'HTML' },
      );
    } catch {
      // "message is not modified" and rate-limit errors are both non-fatal.
    }
  };

  const ticker = setInterval(() => void flush(), 800);

  const results = await runSources(
    ALL_SOURCES,
    subject,
    { now: new Date().toISOString(), hints: subject.hints },
    {
      onResult: (r) => {
        done.push(r);
        dirty = true;
      },
    },
  );

  clearInterval(ticker);
  await flush(true);

  for (const chunk of renderFindings(subject, results)) {
    await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  }

  const summary = await synthesize(subject, results).catch(() => null);
  if (summary) {
    await ctx.reply(`<b>Assessment</b>\n\n${summary}`, { parse_mode: 'HTML' });
  }

  await audit({
    at: new Date().toISOString(),
    telegramUserId: ctx.from!.id,
    username: ctx.from?.username,
    subjectKind: subject.kind,
    subjectValue: subject.value,
    hints: subject.hints,
    sourcesRun: results.map((r) => r.source),
    findingCount: results.reduce((n, r) => n + r.findings.length, 0),
  });
}

/** Girly, non-technical progress lines shown while a trace runs. */
const TRACE_STEPS = [
  '🔍 Digging into their footprint, hold on…',
  '🕸️ Connecting all the dots…',
  '📚 Snooping through the archives…',
  '🛡️ Running the safety checks…',
  '💅 Almost done, putting it together…',
];

/**
 * The whole show: build the identity graph, compute red flags, write the AI
 * dossier, and reply. This is what plain messages AND /trace both run, so a user
 * never has to learn a command — sending "@johndoe" just works.
 */
async function runTrace(ctx: Context, seed: Subject): Promise<void> {
  // Meter the search against the token wallet — the scarcity that drives the
  // daily-return + referral + purchase loops.
  const cost = COST[seed.kind as keyof typeof COST] ?? 10;
  if (!(await spend(ctx.from!.id, cost))) {
    await earnMore(ctx);
    return;
  }

  const status = await ctx.reply('🔍 On it — give me a sec…', { parse_mode: 'HTML' });
  let step = 0;
  const tick = setInterval(() => {
    step = (step + 1) % TRACE_STEPS.length;
    void ctx.api
      .editMessageText(status.chat.id, status.message_id, TRACE_STEPS[step]!, { parse_mode: 'HTML' })
      .catch(() => {});
  }, 2500);

  try {
    const graph = await buildGraph(ALL_SOURCES, seed, { maxDepth: 2, maxNodes: 18 });
    const dossier = await writeDossier(graph).catch(() => ({ signals: [], narrative: null, identityCount: 0, names: [] }));

    clearInterval(tick);
    await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});

    // Community flags — check the network for warnings about this person, keyed to
    // every identifier we know about them (seed + discovered phones/emails/handles).
    const allF = graph.nodes.flatMap((n) => n.findings);
    const keys = subjectKeys(seed, {
      emails: graph.nodes.filter((n) => n.kind === 'email').map((n) => n.value),
      usernames: graph.nodes.filter((n) => n.kind === 'username').map((n) => n.value),
      phones: allF
        .filter((f) => f.source === 'enformion' && f.label === 'Phones')
        .flatMap((f) => (f.detail ?? '').match(/\d[\d\-() ]{8,}\d/g) ?? []),
    });
    // Did the person being checked CLAIM their own Checkmate profile? Show it —
    // the consent-based badge (the second-audience product) surfaces here.
    const badge = await badgeFor(keys).catch(() => null);
    if (badge) {
      const head = badge.verified ? '✅ <b>VERIFIED BY CHECKMATE</b>' : '🪪 <b>They claimed their profile</b>';
      await ctx.reply(
        [
          head,
          `They say they’re <b>${badge.single ? 'single 💚' : 'not single'}</b>${badge.verified ? ` — verified ${escapeHtml(badge.since)}` : ' (free self-claim, unverified)'}.`,
          badge.verified ? '' : '<i>They haven’t paid to verify it — take it as a claim, not proof.</i>',
        ]
          .filter(Boolean)
          .join('\n'),
        { parse_mode: 'HTML' },
      );
    }

    // If the person being checked is a Verified badge-holder, ping THEM: "someone
    // checked you" — Truecaller's dopamine loop, and what makes the badge worth
    // paying for. Anonymous: never who checked them.
    const owner = await verifiedOwnerFor(keys).catch(() => null);
    if (owner && owner !== ctx.from!.id) {
      await ctx.api
        .sendMessage(owner, '👀 <b>Someone just checked you on Checkmate.</b>\nYour ✅ Verified badge showed them you’re real and up-front. 💛', {
          parse_mode: 'HTML',
        })
        .catch(() => {});
    }

    // Remember this user checked this person, so we can ping them if the person
    // is later flagged by the community — the pull-back loop.
    await recordSearch(ctx.from!.id, keys).catch(() => {});
    const flagSummary = await lookupFlags(keys).catch(() => ({ total: 0, byCategory: [], labels: [] }));
    if (flagSummary.total > 0) {
      const lines = [
        '🚨 <b>COMMUNITY ALERT</b>',
        `${flagSummary.total} ${flagSummary.total === 1 ? 'person in the network knows' : 'people in the network know'} <b>${escapeHtml(seed.raw)}</b>:`,
      ];
      if (flagSummary.labels.length) {
        lines.push('', '🏷️ <b>Known as:</b>', ...flagSummary.labels.slice(0, 6).map((l) => `• ${escapeHtml(l.label)}${l.count > 1 ? ` (${l.count})` : ''}`));
      }
      if (flagSummary.byCategory.length) {
        lines.push('', '🚩 <b>Flagged for:</b>', ...flagSummary.byCategory.map((c) => `${FLAG_LABELS[c.category]} — ${c.count}`));
      }
      lines.push('', '<i>Shared by other users, unverified — take it seriously but confirm for yourself.</i>');
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    }

    // "You're not the only one" — social proof that reopens the curiosity gap and
    // makes the network feel alive. Aggregate + anonymous (never who).
    const stats = await checkStats(keys, ctx.from!.id).catch(() => ({ total: 0, recent: 0 }));
    if (stats.total > 0) {
      const line =
        stats.recent > 0
          ? `👀 <b>${stats.total}</b> other ${stats.total === 1 ? 'person has' : 'people have'} checked this exact person (<b>${stats.recent}</b> in the last month). You’re not the only one looking. 🤝`
          : `👀 <b>${stats.total}</b> other ${stats.total === 1 ? 'person has' : 'people have'} checked this exact person before you.`;
      await ctx.reply(line, { parse_mode: 'HTML' });
    }

    const findingTotal = graph.nodes.reduce((n, node) => n + node.findings.length, 0);
    if (findingTotal === 0) {
      lastSearched.set(ctx.from!.id, { seed, keys });
      await ctx.reply(
        [
          '🤷‍♀️ Hmm, came up empty on that one.',
          '',
          'Could mean they keep a low profile — or I just need a better angle. Give me one more thing to go on 👇',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('📧 Their email', 'ask:email')
            .text('📱 Their phone', 'ask:phone')
            .row()
            .text('📸 Their photo', 'ask:image')
            .text('💬 Their @username', 'ask:username'),
        },
      );
      return;
    }

    // Free tier: the verdict card + scoreboard. The juicy detail is paywalled.
    const parts = renderReportParts(seed, graph, dossier);
    for (const chunk of parts.free) {
      await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
    lastSearched.set(ctx.from!.id, { seed, keys, locked: parts.locked, unlocked: new Set(), summary: parts.summary, narrative: dossier.narrative ?? undefined });

    // The money engine: offer each juicy section as a one-tap token unlock.
    if (!parts.thin && parts.locked.length) {
      const kb = new InlineKeyboard();
      parts.locked.forEach((s, i) => {
        kb.text(`${s.label} · ${s.cost}🪙`, `reveal:${s.key}`);
        if (i % 2 === 1) kb.row();
      });
      const bal = await balanceOf(ctx.from!.id);
      await ctx.reply(`🔓 <b>Want the full story?</b> Tap to unlock 👇\n<i>You’ve got <b>${bal}</b> 🪙 — top up free with 🎁 /daily</i>`, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }

    // Everything the user can do next is a TAP, never a typed command. This is
    // the one-tap action hub attached to every report.
    const missing = missingSelectors(seed, graph);
    const actions = new InlineKeyboard()
      .text('🔔 Watch 24/7', 'watch:last')
      .text('📸 Add a photo', 'ask:image')
      .row();
    if (missing.email) actions.text('📧 Add their email', 'ask:email');
    if (missing.phone) actions.text('📱 Add their phone', 'ask:phone');
    if (missing.email || missing.phone) actions.row();
    actions
      .text('🖼️ Share card', 'sharecard')
      .text('🎤 Questions to ask them', 'datequestions')
      .row()
      .text('🚩 Flag them', 'flag')
      .text('🏷️ How you know them', 'label')
      .row()
      .text('🤝 Are we dating the same person?', 'samematch')
      .row()
      .text('🔍 Check someone else', 'check:new');
    await ctx.reply('💫 <b>What next?</b>', { parse_mode: 'HTML', reply_markup: actions });

    await audit({
      at: new Date().toISOString(),
      telegramUserId: ctx.from!.id,
      username: ctx.from?.username,
      subjectKind: `trace:${seed.kind}`,
      subjectValue: seed.value,
      hints: seed.hints,
      sourcesRun: ['trace'],
      findingCount: findingTotal,
    });
  } catch (err) {
    clearInterval(tick);
    await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    await ctx.reply('😬 Something glitched on my end — try again in a moment.');
    console.error('trace error:', err);
  }
}

/**
 * Run a person search, disambiguating first when a no-city name matches several
 * distinct people. Shared by the free-text, button, city-answer and skip paths.
 */
async function runPerson(ctx: Context, seed: Subject): Promise<void> {
  const uid = ctx.from!.id;
  if (!seed.hints) {
    const candidates = await enformionCandidates(seed.value).catch(() => null);
    if (candidates && candidates.length >= 2) {
      const distinctPlaces = new Set(candidates.map((c) => `${c.city ?? ''}|${c.state ?? ''}`));
      if (distinctPlaces.size >= 2) {
        pendingPick.set(uid, { candidates, raw: seed.raw });
        const lines = candidates.map(
          (c, i) =>
            `${i + 1}. <b>${escapeHtml(c.name)}</b>${c.age ? `, ${escapeHtml(c.age)}` : ''}${
              c.city ? ` — ${escapeHtml(c.city)}${c.state ? `, ${escapeHtml(c.state)}` : ''}` : ''
            }`,
        );
        await ctx.reply(
          [`🔎 I found <b>${candidates.length} people</b> named ${escapeHtml(seed.raw)}. Which one? 👇`, '', ...lines, '', 'Reply with the <b>number</b>.'].join('\n'),
          { parse_mode: 'HTML' },
        );
        return;
      }
    }
  }
  await runTrace(ctx, seed);
}

async function main(): Promise<void> {
  await loadConsent();
  // Preload sanctions data in the background so the first OFAC lookup is instant
  // instead of timing out on the initial CSV download.
  void warmOfac();
  const bot = new Bot(requireBotToken());

  const withMenu = { parse_mode: 'HTML', reply_markup: mainMenu } as const;

  bot.command('start', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return;
    // Referral deep link: t.me/Bot?start=ref_<id> — credit both sides once.
    const payload = (ctx.match ?? '').toString().trim();
    const refMatch = /^ref_(\d+)$/.exec(payload);
    if (refMatch) {
      const referrer = Number(refMatch[1]);
      const applied = await applyReferral(uid, referrer);
      if (applied) {
        await ctx.reply(
          `🎉 You came in on a friend’s invite — <b>+${TOKENS.referred} tokens</b> for you, and they got <b>+${TOKENS.referrer}</b> too. Sweet start 💛`,
          { parse_mode: 'HTML' },
        );
        await bot.api
          .sendMessage(referrer, `👯 Someone joined with your invite — <b>+${TOKENS.referrer} tokens</b> for you! Keep sharing 💅`, {
            parse_mode: 'HTML',
          })
          .catch(() => {});
      }
    }
    const granted = await grantStarter(uid);
    if (granted > 0) {
      await ctx.reply(`🎁 Welcome gift: <b>${granted} tokens</b> to start checking. Each search spends a few — top up free anytime with /daily 💛`, {
        parse_mode: 'HTML',
      });
    }
    return consented.has(uid) ? ctx.reply(HELP, withMenu) : ctx.reply(TERMS, { parse_mode: 'HTML' });
  });
  bot.command('help', (ctx) => ctx.reply(HELP, withMenu));
  // Handy for the owner: shows your Telegram ID to put in UNLIMITED_USER_IDS.
  bot.command('id', (ctx) =>
    ctx.reply(`🪪 Your Telegram ID: <code>${ctx.from?.id}</code>`, { parse_mode: 'HTML' }),
  );

  // "Wall of Red Flags" — anonymized recent community flags (no names). The daily-open feed.
  const ago = (iso: string): string => {
    const mins = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  };
  async function showWall(ctx: Context): Promise<void> {
    const items = await recentFlags(20).catch(() => []);
    if (items.length === 0) {
      await ctx.reply('🧱 <b>The Wall is quiet</b> — no flags yet. Be the first to warn the community 🚩', { parse_mode: 'HTML' });
      return;
    }
    const lines = ['🧱 <b>WALL OF RED FLAGS</b>', '<i>Anonymous, community-reported. No names — just the tea. ☕</i>', ''];
    for (const it of items) {
      lines.push(`${FLAG_LABELS[it.category]}${it.state ? ` · ${escapeHtml(it.state)}` : ''} · <i>${ago(it.at)}</i>`);
    }
    lines.push('', '<i>Every flag is one person’s own experience, unverified. 🔍 Check anyone to see if they’re on here.</i>');
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔍 Check someone', 'check:new') });
  }
  bot.command('wall', (ctx) => (guard(ctx) ? showWall(ctx) : undefined));
  bot.callbackQuery('wall', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (guard(ctx)) await showWall(ctx);
  });
  bot.command('check', (ctx) => (guard(ctx) ? ctx.reply('Who are we checking? Pick one 👇', withMenu) : undefined));

  const skipCityKb = new InlineKeyboard().text('⏭ Skip — no city', 'skipcity');

  /** Person + no city → ask for a city first (this is what makes reports full). */
  async function askCityOrRun(ctx: Context, seed: Subject): Promise<void> {
    const uid = ctx.from!.id;
    if (seed.kind === 'person' && !seed.hints) {
      pendingCity.set(uid, seed.raw);
      await ctx.reply(
        `📍 <b>What city or state are they in?</b>\n<i>This makes the report WAY fuller — a name with no city usually comes back thin.</i>`,
        { parse_mode: 'HTML', reply_markup: skipCityKb },
      );
      return;
    }
    if (seed.kind === 'person') return runPerson(ctx, seed);
    return runTrace(ctx, seed);
  }

  // Skip the city prompt → run with just the name.
  bot.callbackQuery('skipcity', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const name = pendingCity.get(ctx.from.id);
    if (!name) return;
    pendingCity.delete(ctx.from.id);
    await runPerson(ctx, detectSubject(name));
  });

  // "🚩 Flag" tapped → show the category picker for the last-searched person.
  bot.callbackQuery('flag', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const last = lastSearched.get(ctx.from.id);
    if (!last) {
      await ctx.reply('Search someone first, then tap 🚩 Flag on their report.');
      return;
    }
    const kb = new InlineKeyboard();
    const cats = Object.keys(FLAG_LABELS) as FlagCategory[];
    cats.forEach((c, i) => {
      kb.text(FLAG_LABELS[c], `flagcat:${c}`);
      if (i % 2 === 1) kb.row();
    });
    await ctx.reply(`What happened with <b>${escapeHtml(last.seed.raw)}</b>? Pick what fits 👇`, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  });

  // "🏷️ How you know them" → ask for a short label (the legal GetContact feature).
  bot.callbackQuery('label', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    if (!lastSearched.get(ctx.from.id)) {
      await ctx.reply('Search someone first, then tap 🏷️ on their report.');
      return;
    }
    pendingLabel.add(ctx.from.id);
    await ctx.reply(
      'What name do you know them by, or how are they saved in your phone?\n<i>(one short label — e.g. “Mike from Hinge” or “Danny — realtor”)</i>',
      { parse_mode: 'HTML' },
    );
  });

  // A category picked → record the flag against the last-searched person.
  bot.callbackQuery(/^flagcat:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery('Thanks — flag added 💛').catch(() => {});
    if (!guard(ctx)) return;
    const last = lastSearched.get(ctx.from.id);
    if (!last) return;
    const category = ctx.match![1] as FlagCategory;
    if (!(category in FLAG_LABELS)) return;
    await addFlag(ctx.from.id, last.keys, category);
    await ctx.reply(
      `✅ Flagged <b>${escapeHtml(last.seed.raw)}</b> as “${escapeHtml(FLAG_LABELS[category])}”. The next person who checks them will see it. You just helped someone 💛`,
      { parse_mode: 'HTML' },
    );

    // Pull-back alert: ping everyone else who checked this person (not the flagger).
    const others = await searchersOf(last.keys, ctx.from.id).catch(() => []);
    for (const uid of others) {
      await bot.api
        .sendMessage(
          uid,
          [
            '🚨 <b>Heads up.</b>',
            '',
            `Someone you checked recently just got flagged by the community: <b>${escapeHtml(FLAG_LABELS[category])}</b>.`,
            '',
            '<i>Another user shared their own experience — unverified, but worth knowing. Re-run them anytime to see the latest.</i>',
          ].join('\n'),
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔍 Check someone', 'check:new') },
        )
        .catch(() => {});
    }
  });

  // "🧠 Read a screenshot" → next image is AI-analysed for red flags, not catfish-checked.
  bot.callbackQuery('ask:screenshot', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    pendingScreenshot.add(ctx.from.id);
    pendingInput.delete(ctx.from.id);
    await ctx.reply(
      '🧠 <b>Screenshot the tea and send it over</b> 📸\nHis dating profile, or your chat with them. I’ll read it for love-bombing, scam scripts, “taken” tells, and anything that doesn’t add up.\n<i>I only read what you send — nothing’s stored.</i>',
      { parse_mode: 'HTML' },
    );
  });

  // Menu button tapped → prompt for that exact input type, no guessing.
  bot.callbackQuery(/^ask:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const kind = ctx.match![1] as SubjectKind;
    const uid = ctx.from.id;
    if (kind === 'image') {
      pendingInput.delete(uid);
    } else {
      pendingInput.set(uid, kind);
    }
    await ctx.reply(ASK_PROMPT[kind] ?? 'Send it over 👇', { parse_mode: 'HTML' });
  });

  // "🔔 Watch 24/7" tapped → watch the last-searched person, zero typing.
  bot.callbackQuery('watch:last', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const last = lastSearched.get(ctx.from.id);
    if (!last) {
      await ctx.reply('Check someone first, then tap 🔔 to keep tabs on them.');
      return;
    }
    const seed = last.seed;
    const note = await ctx.reply(`🔔 Setting up a 24/7 watch on <b>${escapeHtml(seed.raw)}</b>…`, { parse_mode: 'HTML' });
    try {
      const graph = await buildGraph(ALL_SOURCES, seed, { maxDepth: 2, maxNodes: 18 });
      await addWatch(ctx.from.id, seed.kind, seed.value, seed.raw, graph.nodes.map((n) => n.id));
      await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
      await ctx.reply(
        `✅ <b>Watching ${escapeHtml(seed.raw)} 24/7.</b> I’ll ping you the second anything new shows up — new accounts, a new city, a fresh flag. 💖`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('👀 See who I’m watching', 'watchlist').row().text('🔍 Check someone else', 'check:new') },
      );
    } catch {
      await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
      await ctx.reply('😬 Couldn’t set up the watch — try again in a moment.');
    }
  });

  // A locked section tapped → spend tokens (once) and reveal it. The money engine.
  bot.callbackQuery(/^reveal:(.+)$/, async (ctx) => {
    if (!guard(ctx)) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const key = ctx.match![1] as RevealKey;
    const last = lastSearched.get(ctx.from.id);
    const section = last?.locked?.find((s) => s.key === key);
    if (!last || !section) {
      await ctx.answerCallbackQuery('Run a fresh check first 💫').catch(() => {});
      return;
    }
    const already = last.unlocked?.has(key);
    if (!already) {
      if (!(await spend(ctx.from.id, section.cost))) {
        await ctx.answerCallbackQuery({ text: 'Not enough tokens — grab more 👇', show_alert: false }).catch(() => {});
        await earnMore(ctx);
        return;
      }
      last.unlocked?.add(key);
    }
    await ctx.answerCallbackQuery(already ? 'Already unlocked 💛' : `Unlocked! −${section.cost} 🪙`).catch(() => {});
    for (const chunk of section.chunks) {
      await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
    // Re-offer the sections they still haven't unlocked, so the next tap is easy.
    const remaining = (last.locked ?? []).filter((s) => !last.unlocked?.has(s.key));
    if (remaining.length) {
      const kb = new InlineKeyboard();
      remaining.forEach((s, i) => {
        kb.text(`${s.label} · ${s.cost}🪙`, `reveal:${s.key}`);
        if (i % 2 === 1) kb.row();
      });
      const bal = await balanceOf(ctx.from.id);
      await ctx.reply(`🔓 <b>More to uncover</b> — you’ve got <b>${bal}</b> 🪙`, { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // "🤝 Are we dating the same person?" → opt into the match network for the last
  // person searched. Double opt-in + anonymous relay — never an automatic reveal.
  bot.callbackQuery('samematch', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const last = lastSearched.get(ctx.from.id);
    if (!last) {
      await ctx.reply('Check someone first, then tap 🤝 to see if anyone else has dated them.');
      return;
    }
    const already = await hasOptedIn(ctx.from.id, last.keys).catch(() => false);
    const matches = await optIn(ctx.from.id, last.keys).catch(() => [] as number[]);
    if (matches.length === 0) {
      await ctx.reply(
        [
          already ? '✅ You’re already on the list for this person.' : '✅ <b>You’re on the list.</b>',
          '',
          'Nobody else has checked this exact person yet — but the moment someone does, I’ll ping you both to compare notes (anonymously). 🤝',
          '',
          '<i>Your identity is never shared. Ever.</i>',
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
      return;
    }
    // A match! Offer BOTH sides an anonymous channel — neither name is revealed.
    await ctx.reply(
      [
        `🤝 <b>Match found.</b> <b>${matches.length}</b> other ${matches.length === 1 ? 'person has' : 'people have'} checked this exact person too.`,
        '',
        'Want to compare notes? I’ll pass messages between you <b>completely anonymously</b> — no names, no numbers, nothing but what you choose to type.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('💬 Send them an anonymous note', `relay:${matches[0]}`) },
    );
    for (const other of matches) {
      await bot.api
        .sendMessage(
          other,
          [
            '🤝 <b>Someone else just checked a person you looked into.</b>',
            '',
            'They might be dating the same person as you. Want to compare notes anonymously?',
            '',
            '<i>Nobody’s identity is ever shared.</i>',
          ].join('\n'),
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('💬 Send an anonymous note', `relay:${ctx.from.id}`) },
        )
        .catch(() => {});
    }
  });

  // "💬 Send an anonymous note" → next text this user sends is relayed to the target.
  bot.callbackQuery(/^relay:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    pendingRelay.set(ctx.from.id, Number(ctx.match![1]));
    await ctx.reply(
      '💬 <b>Type your message</b> and I’ll pass it along anonymously.\n<i>Be kind and stick to your own experience — messages are between real people. Nothing you type reveals who you are.</i>',
      { parse_mode: 'HTML' },
    );
  });

  // "🖼️ Share card" → send an anonymized, branded verdict image for the group chat/TikTok.
  bot.callbackQuery('sharecard', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const last = lastSearched.get(ctx.from.id);
    if (!last?.summary) {
      await ctx.reply('Run a check first, then tap 🖼️ to get a shareable card.');
      return;
    }
    try {
      const png = renderCardPng(last.summary);
      const link = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;
      await ctx.replyWithPhoto(new InputFile(png, 'checkmate.png'), {
        caption: `♟️ Ran them through Checkmate. Check anyone before you meet them 👇\n${link}`,
      });
    } catch (err) {
      console.error('card render failed:', err);
      await ctx.reply('😬 Couldn’t make the card — try again in a moment.');
    }
  });

  // ── "Claim & Clear" — the second paying audience (people being checked) ──
  bot.callbackQuery('verifyme', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    pendingVerify.add(ctx.from.id);
    await ctx.reply(
      [
        '✅ <b>Claim your own profile</b>',
        '',
        'Tired of getting side-eyed on apps like this? Claim your name so anyone who checks you sees you’re real and up-front.',
        '',
        'Send me <b>your full name</b> (add your city for a sharper match — <code>John Smith | Miami</code>).',
        '<i>No ID, no selfie, nothing stored — just your name and what you choose to share.</i>',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });
  bot.command('verify', (ctx) => {
    if (!guard(ctx)) return;
    pendingVerify.add(ctx.from!.id);
    return ctx.reply('✅ Send me <b>your full name</b> (+ city) to claim your profile.', { parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^vsingle:(yes|no)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const mine = await myProfile(ctx.from.id);
    if (!mine) {
      await ctx.reply('Claim your profile first — tap ✅ Verify yourself.');
      return;
    }
    await claimProfile(ctx.from.id, mine.name, mine.keys, ctx.match![1] === 'yes');
    await ctx.reply(
      [
        `✅ <b>Profile claimed.</b> You’re showing as <b>${ctx.match![1] === 'yes' ? 'single 💚' : 'not single'}</b>.`,
        '',
        'Right now it’s a free self-claim. Lock in the real <b>✅ Verified by Checkmate</b> badge so checkers trust it — and get pinged when someone checks you 👀',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text(`✅ Get Verified — ${BADGE_STARS}⭐ / 30 days`, 'buybadge'),
      },
    );
  });

  bot.callbackQuery('buybadge', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const mine = await myProfile(ctx.from.id);
    if (!mine) {
      await ctx.reply('Claim your profile first — tap ✅ Verify yourself.');
      return;
    }
    await ctx.api
      .sendInvoice(
        ctx.chat!.id,
        '✅ Checkmate Verified badge — 30 days',
        'Show a ✅ Verified badge to anyone who checks you, and get alerts when you’re checked.',
        'badge30',
        'XTR',
        [{ label: 'Verified badge · 30 days', amount: BADGE_STARS }],
      )
      .catch(async () => {
        await ctx.reply('😬 Couldn’t open the payment sheet — try again in a moment.');
      });
  });

  // "🕵️ Is this a scam?" → next message is judged for romance-scam signals.
  bot.callbackQuery('scamcheck', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    pendingScam.add(ctx.from.id);
    await ctx.reply(
      '🕵️ <b>Paste the message</b> they sent you and I’ll tell you if it smells like a scam.\n<i>I read only what you paste — nothing stored.</i>',
      { parse_mode: 'HTML' },
    );
  });
  bot.command('scam', (ctx) => {
    if (!guard(ctx)) return;
    pendingScam.add(ctx.from!.id);
    return ctx.reply('🕵️ Paste the message and I’ll check it for scam signals.');
  });

  // "🎤 Questions to ask them" → AI-generated verification questions for the date.
  bot.callbackQuery('datequestions', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const last = lastSearched.get(ctx.from.id);
    if (!last) {
      await ctx.reply('Check someone first, then tap 🎤 for questions to ask them.');
      return;
    }
    if (!(await spend(ctx.from.id, COST.username))) {
      await earnMore(ctx);
      return;
    }
    const note = await ctx.reply('🎤 Writing your date-night questions…');
    const ctxStr = [last.narrative, last.summary && `Verdict: ${last.summary.verdict}`].filter(Boolean).join('\n');
    const qs = await generateDateQuestions(ctxStr).catch(() => null);
    await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
    await ctx.reply(
      qs
        ? `🎤 <b>What to ask on the date</b>\n<i>Slip these in casually — you’ll know fast if their story holds up.</i>\n\n${escapeHtml(qs)}`
        : '😬 Couldn’t generate those right now — try again in a moment.',
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔍 Check someone else', 'check:new') },
    );
  });

  // "🔍 Check someone else" → straight back to the main menu, no typing.
  bot.callbackQuery('check:new', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    pendingInput.delete(ctx.from.id);
    await ctx.reply('🔍 <b>Who’s next?</b> Pick what you’ve got 👇', { parse_mode: 'HTML', reply_markup: mainMenu });
  });

  // "👀 See who I’m watching" tapped → show the watchlist, no typing.
  bot.callbackQuery('watchlist', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const mine = (await allWatches()).filter((w) => w.userId === ctx.from.id);
    if (!mine.length) {
      await ctx.reply('👀 You’re not watching anyone yet. Check someone, then tap 🔔 Watch 24/7.');
      return;
    }
    const lines = mine.map((w) => `• <b>${escapeHtml(w.raw)}</b> — since ${w.addedAt.slice(0, 10)}`);
    await ctx.reply(`👀 <b>You’re watching:</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  bot.command('budget', async (ctx) => {
    if (!guard(ctx)) return;
    const spent = await spentToday();
    const cap = config.dailySpendCapUsd;
    const pct = Math.round((spent / cap) * 100);
    await ctx.reply(
      `💰 <b>Today's spend:</b> $${spent.toFixed(2)} / $${cap.toFixed(2)} (${pct}%)\n${spent >= cap ? '🔒 Paid sources paused until midnight.' : '✅ Paid sources active.'}`,
      { parse_mode: 'HTML' },
    );
  });

  // ── Retention: wallet, daily streak, referrals ──────────────────────────
  const earnKb = () =>
    new InlineKeyboard().text('🎁 Daily reward', 'daily').text('👯 Invite friends', 'invite');

  async function showBalance(ctx: Context): Promise<void> {
    const uid = ctx.from!.id;
    if (isFree(uid)) {
      await ctx.reply('💎 <b>Tokens: ∞ Unlimited</b>\n<i>Free mode — search and unlock everything, no limits. 💛</i>', {
        parse_mode: 'HTML',
      });
      return;
    }
    const [bal, invited] = await Promise.all([balanceOf(uid), inviteCount(uid)]);
    await ctx.reply(
      [
        `💎 <b>Your tokens:</b> ${bal}`,
        `👯 <b>Friends invited:</b> ${invited}`,
        '',
        'Top up free: /daily every day, /invite your friends 💛',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: earnKb() },
    );
  }

  async function doDaily(ctx: Context): Promise<void> {
    const r = await claimDaily(ctx.from!.id);
    if (!r.ok) {
      await ctx.reply(`✨ Already claimed today — come back tomorrow to keep your <b>${r.streak}-day streak</b> alive! 🔥\n💎 Balance: ${r.balance}`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('👯 Invite for more', 'invite'),
      });
      return;
    }
    const streakLine =
      r.streak % 7 === 0
        ? `🔥🔥 <b>${r.streak}-day streak!</b> Huge bonus unlocked!`
        : r.streak % 3 === 0
          ? `🔥 <b>${r.streak}-day streak!</b> Bonus tokens added!`
          : `🔥 <b>${r.streak}-day streak</b> — keep it going!`;
    await ctx.reply([`🎁 <b>+${r.gained} tokens!</b>`, streakLine, `💎 Balance: ${r.balance}`].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: mainMenu,
    });
  }

  async function doInvite(ctx: Context): Promise<void> {
    const uid = ctx.from!.id;
    const invited = await inviteCount(uid);
    const link = `https://t.me/${botUsername}?start=ref_${uid}`;
    await ctx.reply(
      [
        '👯 <b>Invite friends, both get tokens</b>',
        '',
        `Every friend who joins with your link = <b>+${TOKENS.referrer} tokens</b> for you, <b>+${TOKENS.referred}</b> for them.`,
        `You’ve invited <b>${invited}</b> so far.`,
        '',
        '📩 Share your link:',
        `<code>${link}</code>`,
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().url(
          '📤 Share the link',
          `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Check anyone you’re dating before you meet them 👀 — try Checkmate:')}`,
        ),
      },
    );
  }

  bot.command('balance', (ctx) => (guard(ctx) ? showBalance(ctx) : undefined));
  bot.command('daily', (ctx) => (guard(ctx) ? doDaily(ctx) : undefined));
  bot.command('invite', (ctx) => (guard(ctx) ? doInvite(ctx) : undefined));

  bot.callbackQuery('balance', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (guard(ctx)) await showBalance(ctx);
  });
  bot.callbackQuery('daily', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (guard(ctx)) await doDaily(ctx);
  });
  bot.callbackQuery('invite', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (guard(ctx)) await doInvite(ctx);
  });
  // "💎 Buy tokens" → show the packs, priced in Telegram Stars.
  bot.callbackQuery('buy', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const kb = new InlineKeyboard();
    for (const p of TOKEN_PACKS) {
      kb.text(`${p.tag ? p.tag + ' ' : ''}${p.tokens} tokens · ${p.stars}⭐`, `pack:${p.id}`).row();
    }
    await ctx.reply(
      ['💎 <b>Top up with Telegram Stars</b> ⭐', '', 'Instant, in-app, no card needed. Pick a pack 👇'].join('\n'),
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });
  bot.command('buy', (ctx) => (guard(ctx) ? ctx.reply('💎 Tap below to top up 👇', { reply_markup: new InlineKeyboard().text('💎 Buy tokens', 'buy') }) : undefined));

  // A pack chosen → send a Telegram Stars invoice (currency XTR, no provider token).
  bot.callbackQuery(/^pack:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!guard(ctx)) return;
    const pack = TOKEN_PACKS.find((p) => p.id === ctx.match![1]);
    if (!pack) return;
    await ctx.api
      .sendInvoice(
        ctx.chat!.id,
        `${pack.tokens} Checkmate tokens`,
        `${pack.tokens} tokens to unlock reports, checks and reveals.`,
        `pack:${pack.id}`, // payload — used to credit the right pack on success
        'XTR', // Telegram Stars
        [{ label: `${pack.tokens} tokens`, amount: pack.stars }],
      )
      .catch(async (err) => {
        console.error('sendInvoice failed:', err);
        await ctx.reply('😬 Couldn’t open the payment sheet — try again in a moment.');
      });
  });

  // Telegram asks us to approve the charge — we must answer within 10s.
  bot.on('pre_checkout_query', async (ctx) => {
    await ctx.answerPreCheckoutQuery(true).catch(() => {});
  });

  // Payment succeeded → credit the tokens (or activate the badge).
  bot.on('message:successful_payment', async (ctx) => {
    const pay = ctx.message.successful_payment;
    if (pay.invoice_payload === 'badge30') {
      await setBadgePaid(ctx.from!.id, 30);
      await ctx.reply('✅ <b>You’re Verified for 30 days!</b> 🎉\nAnyone who checks you now sees your ✅ Verified badge. 💛', { parse_mode: 'HTML' });
      await audit({
        at: new Date().toISOString(),
        telegramUserId: ctx.from!.id,
        username: ctx.from?.username,
        subjectKind: 'purchase',
        subjectValue: `badge30:${BADGE_STARS}stars`,
        sourcesRun: ['payment'],
        findingCount: 0,
      });
      return;
    }
    const pack = TOKEN_PACKS.find((p) => `pack:${p.id}` === pay.invoice_payload);
    if (!pack) return;
    await addTokens(ctx.from!.id, pack.tokens);
    const bal = await balanceOf(ctx.from!.id);
    await ctx.reply(
      `✅ <b>Payment received — thank you!</b> 💛\n+${pack.tokens} tokens added. You’ve got <b>${bal}</b> 💎\n\nGo check someone 👇`,
      { parse_mode: 'HTML', reply_markup: mainMenu },
    );
    await audit({
      at: new Date().toISOString(),
      telegramUserId: ctx.from!.id,
      username: ctx.from?.username,
      subjectKind: 'purchase',
      subjectValue: `${pack.id}:${pack.stars}stars`,
      sourcesRun: ['payment'],
      findingCount: pack.tokens,
    });
  });

  bot.command('agree', async (ctx) => {
    const id = ctx.from?.id;
    if (!id) return;
    consented.add(id);
    await saveConsent();
    await ctx.reply(HELP, withMenu);
  });

  const explicit: Record<string, SubjectKind> = {
    u: 'username',
    d: 'domain',
    p: 'person',
    c: 'company',
    e: 'email',
  };

  // Flagship: full trace. Also runs automatically on any plain message.
  bot.command('trace', async (ctx) => {
    if (!guard(ctx)) return;
    const arg = ctx.match?.toString().trim();
    if (!arg || PLACEHOLDER_VALUES.has(arg.toLowerCase().replace(/^@/, ''))) {
      await ctx.reply(NUDGE, withMenu);
      return;
    }
    await runTrace(ctx, detectSubject(arg));
  });

  // Auto-pivot identity graph: seed one selector, recursively expand linked ones.
  bot.command('g', async (ctx) => {
    if (!guard(ctx)) return;
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply('Usage: <code>/g &lt;username|email|domain&gt; value</code>', { parse_mode: 'HTML' });
      return;
    }
    const [kindRaw, ...rest] = arg.split(/\s+/);
    const validKinds: SubjectKind[] = ['username', 'email', 'domain', 'person', 'company'];
    const kind = (validKinds as string[]).includes(kindRaw ?? '')
      ? (kindRaw as SubjectKind)
      : detectSubject(arg).kind;
    const value = ((validKinds as string[]).includes(kindRaw ?? '') ? rest.join(' ') : arg).trim();
    if (!value) {
      await ctx.reply('Give a value to expand from.');
      return;
    }

    const status = await ctx.reply('<b>Building identity graph…</b>', { parse_mode: 'HTML' });
    const trail: string[] = [];
    const result = await buildGraph(
      ALL_SOURCES,
      { raw: value, kind, value: value.replace(/^@/, ''), hints: undefined },
      {
        maxDepth: 2,
        maxNodes: 20,
        onNode: (node, isNew) => {
          if (isNew) trail.push(`+ ${node.kind}:${node.value} ← ${node.via?.reason ?? ''}`);
        },
        onProgress: async (m) => {
          await ctx.api
            .editMessageText(status.chat.id, status.message_id, `<b>Building graph…</b>\n${escapeHtml(m)}\n\n${escapeHtml(trail.slice(-6).join('\n'))}`, {
              parse_mode: 'HTML',
            })
            .catch(() => {});
        },
      },
    );

    await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    for (const chunk of renderGraph(result)) {
      await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }

    await audit({
      at: new Date().toISOString(),
      telegramUserId: ctx.from!.id,
      username: ctx.from?.username,
      subjectKind: `graph:${kind}`,
      subjectValue: value,
      sourcesRun: ['graph'],
      findingCount: result.nodes.length,
    });
  });

  // Start watching a person: run one trace now to set the baseline, then the
  // scheduler diffs future runs against it and pings on changes.
  bot.command('watch', async (ctx) => {
    if (!guard(ctx)) return;
    const arg = ctx.match?.toString().trim();
    if (!arg || PLACEHOLDER_VALUES.has(arg.toLowerCase().replace(/^@/, ''))) {
      await ctx.reply('🔔 Who should I watch? Send  <code>/watch @handle</code>  or  <code>/watch John Smith</code>', {
        parse_mode: 'HTML',
      });
      return;
    }
    const seed = detectSubject(arg);
    const note = await ctx.reply('🔔 Setting up the watch — one baseline scan…');
    try {
      const graph = await buildGraph(ALL_SOURCES, seed, { maxDepth: 2, maxNodes: 18 });
      await addWatch(ctx.from!.id, seed.kind, seed.value, seed.raw, graph.nodes.map((n) => n.id));
      await recordSearch(ctx.from!.id, subjectKeys(seed)).catch(() => {});
      await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
      await ctx.reply(
        `✅ Watching <b>${escapeHtml(seed.raw)}</b>. I’ll ping you if new accounts, domains, or changes show up. Every ~${Math.round(config.watchIntervalMin / 60) || 1}h.\n\nStop anytime with  <code>/unwatch ${escapeHtml(seed.raw)}</code>`,
        { parse_mode: 'HTML' },
      );
    } catch {
      await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
      await ctx.reply('😬 Couldn’t set up the watch — try again in a moment.');
    }
  });

  bot.command('unwatch', async (ctx) => {
    if (!guard(ctx)) return;
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply('Send  <code>/unwatch @handle</code>  (see your list with /watchlist)', { parse_mode: 'HTML' });
      return;
    }
    const removed = await removeWatch(ctx.from!.id, arg);
    await ctx.reply(removed ? `🔕 Stopped watching <b>${escapeHtml(arg)}</b>.` : '🤷‍♀️ You weren’t watching that one.', {
      parse_mode: 'HTML',
    });
  });

  bot.command('watchlist', async (ctx) => {
    if (!guard(ctx)) return;
    const mine = await listWatches(ctx.from!.id);
    if (mine.length === 0) {
      await ctx.reply('👀 You’re not watching anyone yet. Add one with  <code>/watch @handle</code>', { parse_mode: 'HTML' });
      return;
    }
    const lines = mine.map((w) => `• <b>${escapeHtml(w.raw)}</b> — since ${w.addedAt.slice(0, 10)}`);
    await ctx.reply(`👀 <b>You’re watching:</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  for (const [cmd, kind] of Object.entries(explicit)) {
    bot.command(cmd, async (ctx) => {
      if (!guard(ctx)) return;
      const arg = ctx.match?.toString().trim();
      if (!arg) {
        await ctx.reply(`Usage: /${cmd} &lt;value&gt;`, { parse_mode: 'HTML' });
        return;
      }
      const [value, hints] = arg.split('|').map((s) => s.trim());
      await handleLookup(ctx, {
        raw: value ?? arg,
        kind,
        value: (value ?? arg).replace(/^@/, ''),
        hints,
      });
    });
  }

  // Documents preserve metadata; compressed photos do not, because Telegram
  // re-encodes them and strips EXIF on the way through.
  bot.on(['message:document', 'message:photo'], async (ctx) => {
    if (!guard(ctx)) return;

    // "🧠 Read a screenshot" mode → AI red-flag read of the user's own screenshot.
    if (pendingScreenshot.has(ctx.from!.id)) {
      pendingScreenshot.delete(ctx.from!.id);
      if (!(await spend(ctx.from!.id, COST.image))) {
        await earnMore(ctx);
        return;
      }
      const note = await ctx.reply('🧠 Reading the screenshot… holding my drink ☕');
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${requireBotToken()}/${file.file_path}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        const buf = Buffer.from(await res.arrayBuffer());
        const mimeRaw = ctx.message?.document?.mime_type ?? 'image/jpeg';
        const mime: ImageMime = /png/.test(mimeRaw) ? 'image/png' : /webp/.test(mimeRaw) ? 'image/webp' : /gif/.test(mimeRaw) ? 'image/gif' : 'image/jpeg';
        const read = await analyzeScreenshot(buf, mime).catch(() => null);
        await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
        await ctx.reply(
          read
            ? `🧠 <b>SCREENSHOT READ</b>\n\n${escapeHtml(read)}\n\n<i>💡 This reads only what you sent — one data point, not proof. Trust your gut.</i>`
            : '😬 Couldn’t read that one — make sure the text is clear and try again.',
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().text('🧠 Read another', 'ask:screenshot').row().text('🔍 Check the person', 'check:new'),
          },
        );
      } catch {
        await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
        await ctx.reply('😬 Something glitched reading that — try again in a moment.');
      }
      return;
    }

    if (!(await spend(ctx.from!.id, COST.image))) {
      await earnMore(ctx);
      return;
    }
    const isPhoto = Boolean(ctx.message?.photo);
    const note = await ctx.reply(
      isPhoto
        ? '📸 Looking at the photo… psst — next time send it as a <b>File 📎</b> so I can read the hidden data (camera, location, AI-fakery). Compressed photos lose all that.'
        : '📸 Reading the photo — camera, location, AI-fakery check…',
      { parse_mode: 'HTML' },
    );

    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${requireBotToken()}/${file.file_path}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const buf = Buffer.from(await res.arrayBuffer());

      const now = new Date().toISOString();
      // Provenance (EXIF/GPS/AI) and reverse search run together — the first is
      // instant and local, the second is the catfish check (only if a key is set).
      const [provenance, reverse] = await Promise.all([
        analyzeImage(buf, now),
        reverseImageSearch(buf, now).catch(() => null),
      ]);
      const findings = [...(reverse ?? []), ...provenance];

      await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
      const imgChunks = renderImageReport(findings);
      for (let i = 0; i < imgChunks.length; i++) {
        const isLast = i === imgChunks.length - 1;
        await ctx.reply(imgChunks[i]!, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(isLast
            ? {
                reply_markup: new InlineKeyboard()
                  .text('🧑 Now check their name', 'ask:person')
                  .row()
                  .text('📧 Their email', 'ask:email')
                  .text('📱 Their phone', 'ask:phone')
                  .row()
                  .text('🔍 Check someone else', 'check:new'),
              }
            : {}),
        });
      }

      await audit({
        at: new Date().toISOString(),
        telegramUserId: ctx.from!.id,
        username: ctx.from?.username,
        subjectKind: 'image',
        subjectValue: file.file_unique_id,
        sourcesRun: ['image'],
        findingCount: findings.length,
      });
    } catch (err) {
      await ctx.reply(`Image analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    if (!guard(ctx)) return;
    const text = ctx.message.text.trim();
    const uid = ctx.from!.id;

    // Claiming your own profile → next message is your name.
    if (pendingVerify.has(uid) && !text.startsWith('/')) {
      pendingVerify.delete(uid);
      const seed = detectSubject(text);
      const keys = subjectKeys(seed);
      await claimProfile(uid, seed.raw, keys, true);
      await ctx.reply(`✅ Got it — <b>${escapeHtml(seed.raw)}</b>. Are you single?`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('💚 Yes, single', 'vsingle:yes').text('💍 No', 'vsingle:no'),
      });
      return;
    }

    // "Is this a scam?" → judge the pasted message, don't treat it as a search.
    if (pendingScam.has(uid) && !text.startsWith('/')) {
      pendingScam.delete(uid);
      if (!(await spend(uid, COST.username))) {
        await earnMore(ctx);
        return;
      }
      const note = await ctx.reply('🕵️ Reading the message…');
      const verdict = await analyzeScamText(text).catch(() => null);
      await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
      await ctx.reply(
        verdict
          ? `🕵️ <b>SCAM CHECK</b>\n\n${escapeHtml(verdict)}\n\n<i>💡 One read of one message — trust your gut too.</i>`
          : '😬 Couldn’t read that — try again in a moment.',
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🕵️ Check another', 'scamcheck').row().text('🔍 Check the person', 'check:new') },
      );
      return;
    }

    // Composing an anonymous note to a matched user → relay it, reveal nothing.
    if (pendingRelay.has(uid) && !text.startsWith('/')) {
      const target = pendingRelay.get(uid)!;
      pendingRelay.delete(uid);
      const sent = await bot.api
        .sendMessage(
          target,
          [
            '🕵️ <b>Anonymous note</b> from someone who checked the same person as you:',
            '',
            escapeHtml(text.slice(0, 900)),
            '',
            '<i>You can reply anonymously too 👇</i>',
          ].join('\n'),
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('💬 Reply anonymously', `relay:${uid}`) },
        )
        .then(() => true)
        .catch(() => false);
      await ctx.reply(sent ? '✅ Sent anonymously 💛 They can reply without ever seeing who you are.' : '😬 Couldn’t deliver that — they may have blocked the bot.');
      return;
    }

    // If they owe us a disambiguation pick, a bare number selects a candidate.
    const pending = pendingPick.get(uid);
    if (pending && /^\d{1,2}$/.test(text)) {
      const chosen = pending.candidates[Number(text) - 1];
      pendingPick.delete(uid);
      if (!chosen) {
        await ctx.reply('🤔 That number wasn’t on the list — send the name again.');
        return;
      }
      const seed = detectSubject(pending.raw);
      seed.hints = chosen.state; // pin the search to the person they picked
      await ctx.reply(
        `💅 On it — digging into <b>${escapeHtml(chosen.name)}</b>${chosen.city ? ` from ${escapeHtml(chosen.city)}` : ''}…`,
        { parse_mode: 'HTML' },
      );
      await runTrace(ctx, seed);
      return;
    }

    // An unregistered slash command (e.g. "/tracehandle") lands here.
    if (text.startsWith('/')) {
      await ctx.reply(
        `🤔 I don’t know that command. Skip the slash — just send their <b>@username</b>, <b>name</b>, <b>email</b>, <b>phone</b>, or a <b>photo</b> 📸`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Answering "how do you know them?" → store the community label.
    if (pendingLabel.has(uid)) {
      pendingLabel.delete(uid);
      const last = lastSearched.get(uid);
      if (last) {
        await addLabel(uid, last.keys, text);
        await ctx.reply(`✅ Saved — the community now knows them as “${escapeHtml(text.trim().slice(0, 60))}”. You helped someone 💛`, { parse_mode: 'HTML' });
      }
      return;
    }

    // Answering the "what city?" prompt → attach it to the pending name.
    const awaitingCity = pendingCity.get(uid);
    if (awaitingCity) {
      pendingCity.delete(uid);
      const seed = detectSubject(awaitingCity);
      const city = text.trim();
      if (city && !/^(skip|no|none|idk)$/i.test(city)) seed.hints = city;
      await runPerson(ctx, seed);
      return;
    }

    // If they tapped a menu button, treat this message as that exact kind — no
    // guessing. This is what stops "phone 177… and 131…" being read as a name.
    const forced = pendingInput.get(uid);
    if (forced) {
      pendingInput.delete(uid);
      await askCityOrRun(ctx, seedForKind(forced, text));
      return;
    }

    const seed = detectSubject(text);
    if (PLACEHOLDER_VALUES.has(seed.value.toLowerCase())) {
      await ctx.reply(NUDGE, withMenu);
      return;
    }

    // Person with no city → guide them to add one; everything else runs now.
    await askCityOrRun(ctx, seed);
  });

  bot.catch((err) => {
    console.error('bot error:', err.error);
  });

  // Watch loop: periodically re-trace every watched person and DM the owner any
  // change in their linked footprint. Kept sequential and gentle — this is a
  // background job, not a race.
  const runWatchSweep = async (): Promise<void> => {
    const items = await allWatches();
    for (const w of items) {
      try {
        const graph = await buildGraph(ALL_SOURCES, { raw: w.raw, kind: w.kind, value: w.value }, { maxDepth: 2, maxNodes: 18 });
        const currentIds = new Set(graph.nodes.map((n) => n.id));
        const baseline = new Set(w.baselineNodeIds);
        const added = [...currentIds].filter((id) => !baseline.has(id));
        const removed = [...baseline].filter((id) => !currentIds.has(id));

        if (added.length || removed.length) {
          const fmt = (id: string) => {
            const [kind, ...rest] = id.split(':');
            return `${escapeHtml(rest.join(':'))} <i>(${escapeHtml(kind ?? '')})</i>`;
          };
          const lines = [
            `🔔 <b>Update on ${escapeHtml(w.raw)}</b>`,
            '',
            ...(added.length ? ['🆕 <b>New:</b>', ...added.slice(0, 10).map((id) => `• ${fmt(id)}`)] : []),
            ...(removed.length ? ['❌ <b>Gone:</b>', ...removed.slice(0, 10).map((id) => `• ${fmt(id)}`)] : []),
            '',
            `Re-check with  <code>/trace ${escapeHtml(w.raw)}</code>`,
          ];
          await bot.api.sendMessage(w.userId, lines.join('\n'), { parse_mode: 'HTML' }).catch(() => {});
        }
        await updateBaseline(w.id, [...currentIds]);
      } catch (err) {
        console.error(`watch sweep failed for ${w.id}:`, err);
      }
    }
  };

  const intervalMs = Math.max(5, config.watchIntervalMin) * 60_000;
  setInterval(() => void runWatchSweep(), intervalMs);

  // Learn our own @username (for referral links) and publish the command menu.
  try {
    const me = await bot.api.getMe();
    if (me.username) botUsername = me.username;
    await bot.api.setMyCommands([
      { command: 'check', description: '🔍 Check someone new' },
      { command: 'balance', description: '💎 Your tokens' },
      { command: 'daily', description: '🎁 Claim free daily tokens' },
      { command: 'invite', description: '👯 Invite friends, earn tokens' },
      { command: 'watchlist', description: '👀 People you’re watching' },
      { command: 'help', description: '💛 How to use Checkmate' },
    ]);
  } catch {
    // Non-fatal — the bot still runs with the default fallback username.
  }

  console.log(`recon-bot up — ${ALL_SOURCES.length} sources registered, watch sweep every ${config.watchIntervalMin}min`);
  await bot.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
