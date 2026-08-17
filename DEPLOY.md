# Deploy & test

The bot uses Telegram **long-polling**, so it needs no public URL, no webhook, no
open port. It runs anywhere Node runs — your laptop or a Render worker.

## 1. Create the Telegram bot (2 min)

1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, pick a name and a username ending in `bot`.
3. BotFather replies with a **token** like `8123456789:AAH....`. Copy it.

Optional, to lock the bot to just you during testing:
4. Message **@userinfobot** — it replies with your numeric Telegram **user ID**.

## 2. Configure

```bash
cd ~/recon-bot
cp .env.example .env
```

Edit `.env`:

```
BOT_TOKEN=8123456789:AAH....          # from BotFather
ANTHROPIC_API_KEY=sk-ant-....         # for the AI dossier (optional but wanted)
ALLOWED_USER_IDS=<your id>            # optional: private beta lock
BRAVE_API_KEY=                        # optional: web search
```

## 3. Test locally (fastest — do this first)

```bash
npm install
npm run dev
```

You should see `recon-bot up — 11 sources registered`. Now open your bot in
Telegram, send `/start`, then `/agree`, then try:

```
/trace torvalds
/g torvalds
/u torvalds
```

Ctrl-C to stop. This is the full product, running from your Mac. No deploy needed
to test.

## 4. Deploy to Render (always-on)

The included `render.yaml` provisions a **background worker** with a 1 GB disk for
the audit log.

1. Put this repo on GitHub (private):
   ```bash
   git init && git add -A && git commit -m "recon-bot MVP"
   gh repo create recon-bot --private --source=. --push
   ```
2. In the Render dashboard: **New → Blueprint**, point it at the repo. It reads
   `render.yaml`.
3. Set the secret env vars when prompted: `BOT_TOKEN`, `ANTHROPIC_API_KEY`,
   `BRAVE_API_KEY`, `ALLOWED_USER_IDS`.
4. Deploy. The worker starts polling; your bot goes live.

Notes:
- Background workers are a **paid** Render plan (~$7/mo). A free web service would
  spin down on idle and stop the poller, so a worker is the right type.
- Only ever run **one** instance — two pollers on the same token conflict.
- The disk persists `data/audit.jsonl` and `data/consent.json` across deploys.

## Alternatives to Render

Any always-on Node host works the same way: Railway, Fly.io, a $5 VPS. Same
`npm install` / `npm start`, same env vars. Only requirement: one long-running
process with outbound internet.
