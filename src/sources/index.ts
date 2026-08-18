import type { Source } from '../core/types.js';
import { academicSource } from './academic.js';
import { adverseSource } from './adverse.js';
import { blueskySource } from './bluesky.js';
import { brightDataSource } from './brightdata.js';
import { criminalSource } from './criminal.js';
import { hibpSource } from './hibp.js';
import { scamSource } from './scam.js';
import { uniCourtSource } from './unicourt.js';
import { wikipediaSource } from './wikipedia.js';
import { courtListenerSource } from './courtlistener.js';
import { crtshSource } from './crtsh.js';
import { emailRepSource } from './emailrep.js';
import { enformionSource } from './enformion.js';
import { ipqsSource } from './ipqs.js';
import { fecSource } from './fec.js';
import { finraSource } from './finra.js';
import { githubSource } from './github.js';
import { gravatarSource } from './gravatar.js';
import { openCorporatesSource } from './opencorporates.js';
import { piplSource } from './pipl.js';
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
  fecSource,
  openCorporatesSource,
  adverseSource,
  finraSource,
  hibpSource,
  wikipediaSource,
  academicSource,
  scamSource,
  brightDataSource,
  uniCourtSource,
  gravatarSource,
  criminalSource,
  piplSource,
  emailRepSource,
  ipqsSource,
];
