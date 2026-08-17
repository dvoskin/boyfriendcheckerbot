import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bot, type Context } from 'grammy';
import { audit } from './core/audit.js';
import { config, requireBotToken } from './core/config.js';
import { runSources } from './core/runner.js';
import type { SourceResult, Subject, SubjectKind } from './core/types.js';
import { analyzeImage } from './media/provenance.js';
import { writeDossier } from './core/dossier.js';
import { buildGraph } from './core/graph.js';
import { escapeHtml, renderDossier, renderFindings, renderGraph, renderProgress, synthesize } from './report.js';
import { ALL_SOURCES } from './sources/index.js';
import { warmOfac } from './sources/ofac.js';

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
  '<b>Before you search — permitted use</b>',
  '',
  'This tool queries <b>public and official sources only</b>: Internet Archive, ',
  'Certificate Transparency, ICANN RDAP, SEC EDGAR, NPPES, OFAC, court records and ',
  'public web/social pages. It uses no breached or leaked data.',
  '',
  'By continuing you confirm that you will <b>not</b> use results:',
  '• to make decisions about employment, housing, credit, insurance or tenancy ',
  '(that makes this a consumer report under the FCRA and it is not one);',
  '• to harass, stalk, threaten or intimidate anyone;',
  '• in violation of any applicable law.',
  '',
  'Every search is logged with your Telegram ID.',
  '',
  'Send <code>/agree</code> to continue.',
].join('\n');

const HELP = [
  '<b>Commands</b>',
  '',
  '⭐ <code>/trace handle</code> — full dossier: identity graph + red flags + AI assessment',
  '<code>/g handle</code> — identity graph only (linked accounts/emails/domains)',
  '',
  '<code>/u handle</code> — username across social surfaces, Bluesky, GitHub, archive',
  '<code>/d example.com</code> — RDAP, Certificate Transparency, archived history',
  '<code>/p John Smith | FL</code> — person: NPPES, SEC, OFAC, courts, web',
  '<code>/c Acme LLC</code> — company: SEC, NPPES, OFAC, web',
  '<code>/e a@b.com</code> — email: GitHub, web',
  '',
  'Or just send a handle, domain, email or name and it will pick the type.',
  'Send a <b>photo as a file</b> (not compressed) for EXIF, GPS, C2PA and AI-generation checks.',
  '',
  '<i>Compressed photos have their metadata stripped by Telegram — always attach as a document.</i>',
].join('\n');

/** Best-effort type detection so plain messages work without a command. */
function detectSubject(text: string): Subject {
  const raw = text.trim();
  const [beforePipe, afterPipe] = raw.split('|').map((s) => s.trim());
  const value = beforePipe ?? raw;
  const hints = afterPipe;

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

async function main(): Promise<void> {
  await loadConsent();
  // Preload sanctions data in the background so the first OFAC lookup is instant
  // instead of timing out on the initial CSV download.
  void warmOfac();
  const bot = new Bot(requireBotToken());

  bot.command('start', (ctx) =>
    ctx.reply(consented.has(ctx.from?.id ?? 0) ? HELP : TERMS, { parse_mode: 'HTML' }),
  );
  bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  bot.command('agree', async (ctx) => {
    const id = ctx.from?.id;
    if (!id) return;
    consented.add(id);
    await saveConsent();
    await ctx.reply(`Recorded. ${'\n\n'}${HELP}`, { parse_mode: 'HTML' });
  });

  const explicit: Record<string, SubjectKind> = {
    u: 'username',
    d: 'domain',
    p: 'person',
    c: 'company',
    e: 'email',
  };

  // Flagship: full trace — identity graph + deterministic red flags + AI dossier.
  bot.command('trace', async (ctx) => {
    if (!guard(ctx)) return;
    const arg = ctx.match?.toString().trim();
    if (!arg) {
      await ctx.reply('Usage: <code>/trace &lt;username|email|domain|person&gt; value</code>', { parse_mode: 'HTML' });
      return;
    }
    const [kindRaw, ...rest] = arg.split(/\s+/);
    const validKinds: SubjectKind[] = ['username', 'email', 'domain', 'person', 'company'];
    const hasKind = (validKinds as string[]).includes(kindRaw ?? '');
    const kind = hasKind ? (kindRaw as SubjectKind) : detectSubject(arg).kind;
    const value = (hasKind ? rest.join(' ') : arg).trim();
    if (!value) {
      await ctx.reply('Give a value to trace.');
      return;
    }

    const status = await ctx.reply('<b>Tracing…</b> building identity graph', { parse_mode: 'HTML' });
    const seed: Subject = { raw: value, kind, value: value.replace(/^@/, ''), hints: undefined };

    const graph = await buildGraph(ALL_SOURCES, seed, {
      maxDepth: 2,
      maxNodes: 18,
      onProgress: async (m) => {
        await ctx.api
          .editMessageText(status.chat.id, status.message_id, `<b>Tracing…</b>\n${escapeHtml(m)}`, { parse_mode: 'HTML' })
          .catch(() => {});
      },
    });

    await ctx.api.editMessageText(status.chat.id, status.message_id, '<b>Tracing…</b> writing dossier', { parse_mode: 'HTML' }).catch(() => {});
    const dossier = await writeDossier(graph).catch(() => ({ signals: [], narrative: null, identityCount: 0, names: [] }));

    await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
    for (const chunk of renderDossier(seed, dossier)) {
      await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
    for (const chunk of renderGraph(graph)) {
      await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }

    await audit({
      at: new Date().toISOString(),
      telegramUserId: ctx.from!.id,
      username: ctx.from?.username,
      subjectKind: `trace:${kind}`,
      subjectValue: value,
      sourcesRun: ['trace'],
      findingCount: graph.nodes.reduce((n, node) => n + node.findings.length, 0),
    });
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
        ? 'Analysing — note that Telegram strips EXIF from compressed photos. Re-send as a file for full metadata.'
        : 'Analysing image…',
    );

    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${requireBotToken()}/${file.file_path}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const buf = Buffer.from(await res.arrayBuffer());

      const findings = await analyzeImage(buf, new Date().toISOString());
      const subject: Subject = { raw: file.file_unique_id, kind: 'image', value: file.file_unique_id };
      const result: SourceResult = {
        source: 'image',
        label: 'Image provenance',
        ok: true,
        findings,
        ms: 0,
      };

      await ctx.api.deleteMessage(note.chat.id, note.message_id).catch(() => {});
      for (const chunk of renderFindings(subject, [result])) {
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
    if (ctx.message.text.startsWith('/')) return;
    if (!guard(ctx)) return;
    await handleLookup(ctx, detectSubject(ctx.message.text));
  });

  bot.catch((err) => {
    console.error('bot error:', err.error);
  });

  console.log(`recon-bot up — ${ALL_SOURCES.length} sources registered`);
  await bot.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
