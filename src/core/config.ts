import 'dotenv/config';

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/**
 * BOT_TOKEN is validated at bot startup rather than at import time, so the CLI
 * probe can exercise every source without a Telegram token configured.
 */
export function requireBotToken(): string {
  const v = config.botToken;
  if (!v) throw new Error('Missing BOT_TOKEN (copy .env.example to .env)');
  return v;
}

export const config = {
  botToken: opt('BOT_TOKEN'),
  contactEmail: process.env.CONTACT_EMAIL ?? 'unknown@example.com',
  anthropicKey: opt('ANTHROPIC_API_KEY'),
  braveKey: opt('BRAVE_API_KEY'),
  serpapiKey: opt('SERPAPI_KEY'),
  githubToken: opt('GITHUB_TOKEN'),
  courtListenerToken: opt('COURTLISTENER_TOKEN'),
  dataDir: process.env.DATA_DIR ?? './data',
  allowedUserIds: (process.env.ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
};

/**
 * SEC and archive.org both ask API clients to self-identify with a contact
 * address and will throttle clients that do not. Sending one is the difference
 * between working and getting 403'd at volume.
 */
export const USER_AGENT = `recon-bot/0.1 (${config.contactEmail})`;
