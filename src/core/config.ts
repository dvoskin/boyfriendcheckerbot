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
  twilioSid: opt('TWILIO_ACCOUNT_SID'),
  twilioToken: opt('TWILIO_AUTH_TOKEN'),
  // Enformion / EnformionGO (formerly Endato) people-data aggregator.
  enformionName: opt('ENFORMION_AP_NAME'),
  enformionPassword: opt('ENFORMION_AP_PASSWORD'),
  // FEC (openFEC) political-donations API. DEMO_KEY works but is rate-limited;
  // a free api.data.gov key lifts the limit.
  fecKey: opt('FEC_API_KEY') ?? 'DEMO_KEY',
  // HaveIBeenPwned API key ($3.95/mo) — email → data breaches he's been in.
  hibpKey: opt('HIBP_API_KEY'),
  // Bright Data Web Unlocker — public Instagram/TikTok profile data (legal).
  brightDataKey: opt('BRIGHTDATA_API_KEY'),
  brightDataZone: opt('BRIGHTDATA_ZONE') ?? 'web_unlocker1',
  // UniCourt — state & federal court records (criminal, civil, family/divorce).
  // OAuth2 client credentials.
  uniCourtClientId: opt('UNICOURT_CLIENT_ID'),
  uniCourtClientSecret: opt('UNICOURT_CLIENT_SECRET'),
  // TinEye — true exact-match reverse image (better than look-alikes).
  tineyeKey: opt('TINEYE_API_KEY'),
  // Pipl — deep identity resolution (email/name → social, phones, jobs).
  piplKey: opt('PIPL_API_KEY'),
  // EmailRep.io — email reputation / suspiciousness (free; key lifts limits).
  emailRepKey: opt('EMAILREP_API_KEY'),
  // IPQualityScore — phone/email fraud + burner/disposable detection (free tier).
  ipqsKey: opt('IPQS_API_KEY'),
  dataDir: process.env.DATA_DIR ?? './data',
  // How often the watch loop re-checks each watched person, in minutes.
  watchIntervalMin: Number(process.env.WATCH_INTERVAL_MIN ?? '360'),
  // Daily cap (USD) on the paid data sources. Once hit, paid sources pause for
  // the day while the free ones keep working. Protects against a surprise bill.
  dailySpendCapUsd: Number(process.env.DAILY_SPEND_CAP_USD ?? '50'),
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
