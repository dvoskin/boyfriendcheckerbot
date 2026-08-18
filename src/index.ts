import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { audit } from './core/audit.js';
import { config, requireBotToken } from './core/config.js';
import { runSources } from './core/runner.js';
import type { SourceResult, Subject, SubjectKind } from './core/types.js';
import { analyzeImage } from './media/provenance.js';
import { reverseImageSearch } from './media/reverse.js';
import { spentToday } from './core/budget.js';
import { writeDossier } from './core/dossier.js';
import { addFlag, addLabel, type FlagCategory, FLAG_LABELS, lookupFlags, subjectKeys } from './core/flags.js';
import { buildGraph } from './core/graph.js';
import { addWatch, allWatches, listWatches, removeWatch, updateBaseline } from './core/watch.js';
import { escapeHtml, renderFindings, renderGraph, renderImageReport, renderProgress, renderReport, synthesize } from './report.js';
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
const lastSearched = new Map<number, { seed: Subject; keys: string[] }>();

/** Users we asked "how do you know them?" — their next message is the label. */
const pendingLabel = new Set<number>();

/** The tap-to-choose input menu — removes the guesswork of free-text parsing. */
const mainMenu = new InlineKeyboard()
  .text('🧑 Name', 'ask:person')
  .text('💬 Username', 'ask:username')
  .row()
  .text('📧 Email', 'ask:email')
  .text('📱 Phone', 'ask:phone')
  .row()
  .text('📸 Photo', 'ask:image');

const ASK_PROMPT: Record<string, string> = {
  person: 'Send me their <b>full name</b> 🧑\n<i>Tip: add a city for a sharper match — <code>John Smith | Miami</code></i>',
  username: 'Send me their <b>@username</b> 💬  (Instagram, TikTok, etc.)',
  email: 'Send me their <b>email</b> 📧',
  phone: 'Send me their <b>phone number</b> 📱',
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
  const status = await ctx.reply('💅 On it, bestie — give me a sec…', { parse_mode: 'HTML' });
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

    const findingTotal = graph.nodes.reduce((n, node) => n + node.findings.length, 0);
    if (findingTotal === 0) {
      await ctx.reply(
        [
          '🤷‍♀️ Hmm, came up empty on that one.',
          '',
          'Could mean they keep a low profile — or I just need a better angle. Try sending their:',
          '📧 email · 📱 phone · 📸 photo (as a File) · or a different @username 💫',
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
    } else {
      for (const chunk of renderReport(seed, graph, dossier)) {
        await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      }
    }

    // Offer to add their own experience to the network — the viral loop.
    lastSearched.set(ctx.from!.id, { seed, keys });
    if (flagSummary.labels.length > 0) {
      // (labels already shown in the alert above)
    }
    await ctx.reply('💬 Know them? Help the next person 👇', {
      reply_markup: new InlineKeyboard()
        .text('🚩 Flag this person', 'flag')
        .row()
        .text('🏷️ How you know them', 'label'),
    });

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

  bot.command('start', (ctx) =>
    consented.has(ctx.from?.id ?? 0)
      ? ctx.reply(HELP, withMenu)
      : ctx.reply(TERMS, { parse_mode: 'HTML' }),
  );
  bot.command('help', (ctx) => ctx.reply(HELP, withMenu));
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
    const isPhoto = Boolean(ctx.message?.photo);
    const note = await ctx.reply(
      isPhoto
        ? '📸 Looking at his photo… psst — next time send it as a <b>File 📎</b> so I can read the hidden data (camera, location, AI-fakery). Compressed photos lose all that.'
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
      for (const chunk of renderImageReport(findings)) {
        await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
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

    // If they owe us a disambiguation pick, a bare number selects a candidate.
    const pending = pendingPick.get(uid);
    if (pending && /^\d{1,2}$/.test(text)) {
      const chosen = pending.candidates[Number(text) - 1];
      pendingPick.delete(uid);
      if (!chosen) {
        await ctx.reply('🤔 That number wasn’t on the list — send his name again.');
        return;
      }
      const seed = detectSubject(pending.raw);
      seed.hints = chosen.state; // pin the search to the person she picked
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

  console.log(`recon-bot up — ${ALL_SOURCES.length} sources registered, watch sweep every ${config.watchIntervalMin}min`);
  await bot.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
