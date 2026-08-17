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
];

const INDEX = new Map<string, number>();
GROUPS.forEach((g, i) => g.forEach((n) => INDEX.set(n, i)));

export function firstNameMatches(searched: string, returned: string): boolean {
  const a = searched.trim().toLowerCase();
  const b = returned.trim().toLowerCase();
  if (!a || !b) return true; // no basis to reject
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true; // Dan / Daniel
  const ga = INDEX.get(a);
  const gb = INDEX.get(b);
  return ga !== undefined && ga === gb; // Mike / Mikhail
}
