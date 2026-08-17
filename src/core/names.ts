/**
 * Nickname-aware first-name matching. People search under nicknames ("Mike") but
 * records store the legal name ("Mikhail"/"Michael"), and a naive equality/prefix
 * check throws away the correct record — which is exactly how a search for "Mike
 * Parizher" showed nothing while his real record sat under "Mikhail Parizher".
 *
 * Groups list interchangeable forms. Matching is: equal, prefix either way, or
 * both names resolve into the same group. This keeps the wrong-person guard
 * strict on genuinely different names (Ariel ≠ Michael) while accepting nicknames.
 */
const GROUPS: string[][] = [
  ['michael', 'mike', 'mikey', 'mick', 'mickey', 'mikhail', 'misha', 'micha'],
  ['robert', 'rob', 'bob', 'bobby', 'robbie', 'bert'],
  ['william', 'will', 'bill', 'billy', 'willy', 'liam'],
  ['richard', 'rich', 'rick', 'ricky', 'dick', 'richie'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'johnny', 'jon', 'jack', 'jackie', 'ivan'],
  ['joseph', 'joe', 'joey', 'josef'],
  ['daniel', 'dan', 'danny', 'danil', 'danila'],
  ['david', 'dave', 'davey', 'davy'],
  ['charles', 'charlie', 'chuck', 'chas', 'chip'],
  ['thomas', 'tom', 'tommy'],
  ['christopher', 'chris', 'topher', 'kit'],
  ['matthew', 'matt', 'matty'],
  ['anthony', 'tony', 'anton'],
  ['edward', 'ed', 'eddie', 'ted', 'teddy', 'ned'],
  ['benjamin', 'ben', 'benny', 'benji'],
  ['nicholas', 'nick', 'nicky', 'nikolai', 'nikola', 'kolya'],
  ['alexander', 'alex', 'al', 'sasha', 'sander', 'lex', 'xander'],
  ['andrew', 'andy', 'drew', 'andrei', 'andrey'],
  ['joshua', 'josh'],
  ['nathaniel', 'nathan', 'nate'],
  ['samuel', 'sam', 'sammy'],
  ['stephen', 'steven', 'steve', 'stevie'],
  ['kenneth', 'ken', 'kenny'],
  ['ronald', 'ron', 'ronnie'],
  ['donald', 'don', 'donnie', 'donny'],
  ['timothy', 'tim', 'timmy'],
  ['jeffrey', 'jeff', 'geoff'],
  ['gregory', 'greg', 'gregg'],
  ['vincent', 'vince', 'vinny', 'vin'],
  ['patrick', 'pat', 'paddy', 'rick'],
  ['francis', 'frank', 'frankie', 'fran'],
  ['lawrence', 'larry', 'lars'],
  ['gerald', 'gerry', 'jerry'],
  ['albert', 'al', 'bert', 'albie'],
  ['frederick', 'fred', 'freddie', 'fritz'],
  ['eugene', 'gene'],
  ['raymond', 'ray'],
  ['philip', 'phil', 'phillip'],
  ['peter', 'pete', 'petey', 'pyotr', 'petr'],
  ['george', 'georgie', 'georgy'],
  ['henry', 'hank', 'harry'],
  ['walter', 'walt', 'wally'],
  ['dennis', 'denny', 'denis'],
  ['douglas', 'doug'],
  ['gabriel', 'gabe'],
  ['leonard', 'leo', 'lenny', 'len'],
  ['theodore', 'theo', 'ted', 'teddy'],
  ['zachary', 'zach', 'zack'],
  ['maxwell', 'max'],
  ['maximilian', 'max', 'maxim', 'maks'],
  ['dmitry', 'dmitri', 'dima', 'mitya'],
  ['vladimir', 'vlad', 'vova', 'volodya'],
  ['sergey', 'sergei', 'serge', 'seryozha'],
  ['yevgeny', 'evgeny', 'eugene', 'zhenya'],
  ['grigory', 'grigori', 'greg', 'grisha'],
  ['konstantin', 'kostya', 'kostas'],
  ['aleksandr', 'alexander', 'alex', 'sasha'],
  // Common women's-name families (nicknames + regional/anglicised forms).
  ['frances', 'francisca', 'francesca', 'francine', 'fran', 'franny', 'francis'],
  ['elizabeth', 'liz', 'lizzy', 'beth', 'betty', 'eliza', 'lisa', 'liza', 'betsy', 'ella'],
  ['katherine', 'catherine', 'kate', 'katie', 'kathy', 'cathy', 'kat', 'katia', 'kitty', 'catalina'],
  ['margaret', 'maggie', 'meg', 'peggy', 'marge', 'greta', 'rita'],
  ['victoria', 'vicky', 'vic', 'tori', 'vika'],
  ['jennifer', 'jen', 'jenny', 'jenna'],
  ['jessica', 'jess', 'jessie'],
  ['patricia', 'pat', 'patty', 'trish', 'tricia'],
  ['deborah', 'debra', 'deb', 'debbie'],
  ['barbara', 'barb', 'babs'],
  ['susan', 'sue', 'suzie', 'susana', 'susanna'],
  ['christina', 'christine', 'chris', 'chrissy', 'tina', 'kristina', 'kristine'],
  ['stephanie', 'steph', 'stephany'],
  ['alexandra', 'alexandria', 'alex', 'ally', 'lexi', 'sasha', 'sandra'],
  ['gabriela', 'gabriella', 'gaby', 'gabby', 'gabrielle'],
  ['daniela', 'daniella', 'dani', 'danielle'],
  ['mary', 'marie', 'maria', 'molly', 'mamie'],
  ['anna', 'ana', 'annie', 'anya', 'anastasia', 'nastya', 'anka'],
  ['natalie', 'natalia', 'nat', 'natasha', 'talia'],
  ['ekaterina', 'katya', 'katerina', 'kate'],
];

// A nickname can belong to several groups (e.g. "rick" → Richard AND Patrick,
// "bert" → Robert AND Albert). Storing only the last group silently broke valid
// matches, so map each name to EVERY group it appears in and match on overlap.
const INDEX = new Map<string, number[]>();
GROUPS.forEach((g, i) =>
  g.forEach((n) => {
    const arr = INDEX.get(n) ?? [];
    arr.push(i);
    INDEX.set(n, arr);
  }),
);

export function firstNameMatches(searched: string, returned: string): boolean {
  const a = searched.trim().toLowerCase();
  const b = returned.trim().toLowerCase();
  if (!a || !b) return true; // no basis to reject
  if (a === b) return true;
  // Prefix only when the shorter side is ≥3 chars — otherwise "Al" wrongly
  // matches Alexandra/Alan/Albert and short names defeat the wrong-person guard.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return true; // Dan / Daniel
  const ga = INDEX.get(a);
  const gb = INDEX.get(b);
  return !!ga && !!gb && ga.some((x) => gb.includes(x)); // Mike / Mikhail
}

/** Valid US state codes, so a stray 2-letter token (e.g. "SF") isn't read as a state. */
export const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]);

/** Pull a real US state code out of a free-text hint, or undefined. */
export function stateFromHint(hint?: string): string | undefined {
  if (!hint) return undefined;
  for (const m of hint.toUpperCase().matchAll(/\b([A-Z]{2})\b/g)) {
    if (US_STATES.has(m[1]!)) return m[1];
  }
  return undefined;
}
