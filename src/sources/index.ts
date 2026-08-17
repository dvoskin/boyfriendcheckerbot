import type { Source } from '../core/types.js';
import { blueskySource } from './bluesky.js';
import { courtListenerSource } from './courtlistener.js';
import { crtshSource } from './crtsh.js';
import { enformionSource } from './enformion.js';
import { githubSource } from './github.js';
import { nppesSource } from './nppes.js';
import { ofacSource } from './ofac.js';
import { phoneSource } from './phone.js';
import { rdapSource } from './rdap.js';
import { registrySource } from './registry.js';
import { searchSource } from './search.js';
import { secSource } from './sec.js';
import { usernameSource } from './usernames.js';
import { waybackSource } from './wayback.js';

/**
 * Adding a source is one file plus one line here. Anything that throws or returns
 * null is reported as a gap in the final report rather than failing the lookup,
 * so a broken source degrades the answer instead of breaking the bot.
 */
export const ALL_SOURCES: Source[] = [
  usernameSource,
  blueskySource,
  githubSource,
  waybackSource,
  searchSource,
  rdapSource,
  crtshSource,
  nppesSource,
  ofacSource,
  secSource,
  courtListenerSource,
  phoneSource,
  registrySource,
  enformionSource,
];
