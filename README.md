# recon-bot

A Telegram OSINT bot that queries **public and official sources only**. No breached
or leaked data, no authenticated scraping, no biometric face matching. It is built
for entity due-diligence and self-checks, not covert surveillance of individuals.

## What it does

Send a username, domain, email, person, company — or an image file — and it fans out
to every applicable source in parallel, streams results as they land, and returns a
structured report with a source and timestamp on every fact.

```
/u torvalds              username across social surfaces, Bluesky, GitHub, archive
/d example.com           RDAP, Certificate Transparency, archived history
/p John Smith | FL       person: NPPES, SEC, OFAC, courts, web
/c Acme LLC              company: SEC, NPPES, OFAC, web
/e a@b.com               email: GitHub, web
(image as a file)        EXIF, GPS, C2PA, AI-generation and hash provenance
```

## Sources

| Source | Kinds | Key? | Notes |
|---|---|---|---|
| Social surfaces | username | no | 40+ sites, calibrated to **zero false positives** |
| Bluesky | username, person | no | full public graph, no auth |
| GitHub | username, email | optional | 60/hr anon, 5000/hr with any token |
| Internet Archive (CDX) | username, domain | no | proves deleted/renamed profiles existed |
| Web search | all | **yes** | Brave or SerpAPI (Bing API is dead since 2025-08-11) |
| ICANN RDAP | domain | no | registration, registrar, contacts (mostly redacted) |
| Certificate Transparency | domain | no | full subdomain history via crt.sh |
| NPPES | person, company | no | 8M US healthcare providers + license numbers |
| OFAC SDN | person, company | no | sanctions screening, US-gov public domain |
| SEC EDGAR | person, company, domain | no | full-text filing search, Form D lists officers |
| CourtListener | person, company | optional | free tier is 125/**day** — use bulk for prod |

A source that fails or lacks a key is reported as a **gap in the report**, never
silently dropped. The lookup degrades; it does not break.

## Why the enumerator is trustworthy

Blind URL probing is the classic OSINT footgun: many sites answer `200` with a
"not found" shell (soft-404), so status-code detection invents accounts that do
not exist. Our first pass had an **11-of-22 false-positive rate**.

Two scripts fix and keep it fixed:

- `npx tsx src/scripts/calibrate.ts` probes every site with impossible handles and
  flags any that report a hit. Run it after editing the site list.
- `npx tsx src/scripts/diff-markers.ts '<url-template>' <real-handle>` derives a
  discriminator for a soft-404 site.

Sites with no reliable server-side signal (Instagram, Reddit, Telegram, Pinterest)
are **not probed** — they are covered by the search layer and the archive instead.
TikTok is kept via a content marker (`"userInfo"` present only for real profiles).

## The legal boundary — read this

This tool is lawful **because** every source is public or official. That property is
load-bearing; do not add a source that breaks it.

Out of scope, permanently, regardless of demand:

- **Private platform data** — who someone likes/follows/matches privately on
  Facebook, Instagram, Tinder, etc. Behind a login = CFAA. There is no legal API or
  broker for it. Monitoring one person's private social/romantic activity is
  stalkerware and a separate crime in many states.
- **Leaked/breached datasets** of any kind.
- **DPPA data** — DMV records, license-plate-to-owner (federal criminal statute).
- **Face recognition** — Illinois BIPA is $1,000–5,000 per scan with a live class bar.
- **FCRA uses** — employment, housing, credit, insurance, tenancy decisions. The
  consent gate makes users attest they will not do this.

Before going commercial: data-broker registration (CA/TX/OR/VT), an FCRA disclaimer
reviewed by counsel, and the append-only audit log (already written to
`data/audit.jsonl`) kept immutable.

## Run

```bash
cp .env.example .env       # set BOT_TOKEN, CONTACT_EMAIL; keys are optional
npm install
npm run dev                # or: npm start
```

Test sources without a bot token:

```bash
npx tsx src/scripts/probe.ts username torvalds
npx tsx src/scripts/probe.ts domain example.com
npx tsx src/scripts/probe.ts person "Jane Doe" "TX"
```

## Layout

```
src/
  core/     config, http (retry+cache), runner (parallel+deadline), audit, cache
  sources/  one file per source, registered in sources/index.ts
  media/    image provenance (EXIF/GPS/C2PA/hash)
  scripts/  probe (manual test), calibrate + diff-markers (enumerator QA)
  report.ts Telegram rendering + optional Claude synthesis
  index.ts  bot wiring, consent gate, image handler
```

Adding a source is one file implementing the `Source` interface plus one line in
`sources/index.ts`.
