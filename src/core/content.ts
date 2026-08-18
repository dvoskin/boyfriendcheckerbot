/**
 * Editorial content — the daily habit layer. Dating-safety tips ("red flag of the
 * day") and a "red flag or fine?" quiz. Kept as plain data so it powers the /tip
 * command, the daily reward, the quiz game, and the companion channel from one place.
 *
 * Voice: the user's protective, slightly sassy friend. Gender-neutral (they/them),
 * works for anyone checking anyone.
 */

/** One dating-safety tip / red-flag lesson. Short, punchy, screenshot-friendly. */
export const TIPS: string[] = [
  '🚩 <b>Love-bombing</b> — "soulmate" energy in 3 days, constant gifts, talk of the future fast. It feels amazing on purpose. Real connection isn’t in a rush.',
  '🚩 <b>They won’t video-call before meeting.</b> Cameras "never work," they’re "shy." A 30-second live call is the #1 catfish killer. If they dodge it, that’s your answer.',
  '🚩 <b>They only text at odd hours</b> and go quiet on weekends. Classic "I have another life" (read: a partner) pattern.',
  '🚩 <b>Any money talk = stop.</b> A crypto "opportunity," an emergency, a plane ticket, gift cards. Nobody you met online needs your money. Nobody.',
  '💡 <b>Reverse-search their photos</b> before you catch feelings. If the same face is on 4 profiles under 3 names, it’s stolen.',
  '🚩 <b>"I’m separated / it’s complicated."</b> Translation: taken. You’re the side quest. You deserve the main story.',
  '💡 <b>Screenshot the good stuff early.</b> If they later deny saying it, you’ll be glad you have the receipts.',
  '🚩 <b>Breadcrumbing</b> — just enough attention to keep you hooked, never enough to commit. If you’re always waiting, you’re being strung along.',
  '💡 <b>Meet in public, tell a friend where you’ll be,</b> and drive yourself. Boring advice, saves lives.',
  '🚩 <b>They rush you off the app</b> to WhatsApp/Telegram fast. Scammers hate leaving a paper trail on the dating platform.',
  '💡 <b>Trust the ick.</b> That "something’s off" feeling is your brain noticing a pattern before you can name it. Check first, catch feelings later.',
  '🚩 <b>Their story keeps changing</b> — job, age, city, why the last one ended. Real life is consistent. Lies need maintenance.',
  '🚩 <b>They love-bomb, then punish.</b> Sweet, then cold when you don’t jump. That whiplash is a tactic, not a mood.',
  '💡 <b>Ask specific questions</b> you can verify later: which office, which gym, which neighborhood. Liars get vague fast.',
  '🚩 <b>"Don’t tell anyone about us."</b> Secrecy protects the person with something to hide — not you.',
  '💡 <b>A clean background check isn’t a clean bill of health.</b> Most harm never becomes a record. Your gut still gets a vote.',
  '🚩 <b>They mirror you too perfectly</b> — same everything, instantly. Sometimes it’s chemistry. Sometimes it’s a con reading your profile back to you.',
  '💡 <b>Google their number and email too,</b> not just the name — burner digits and throwaway emails are a scammer tell.',
  '🚩 <b>Guilt-trips when you set a boundary.</b> "After everything I did for you?" A good person respects a no.',
  '💡 <b>New relationship, big feelings — slow the timeline anyway.</b> Anyone rushing you past your comfort is doing it for a reason.',
  '🚩 <b>They have no online footprint at all,</b> or it’s brand new. Everyone has *something*. A ghost is worth a closer look.',
  '💡 <b>If they get a "family emergency" right when things get real,</b> and it comes with a money ask — it’s a script. Millions of people fall for it.',
  '🚩 <b>Pocketing</b> — months in, still not on their socials, never met a friend. You’re being hidden.',
  '💡 <b>Do the check before the first date, not after the third.</b> The point is to protect the version of you who hasn’t fallen yet.',
  '🚩 <b>"You’re not like other people, everyone else betrayed me."</b> Painting all their exes as crazy is a red flag about them, not the exes.',
];

/** Deterministic "tip of the day" — same for everyone on a given day. */
export function tipOfDay(): string {
  const day = Math.floor(Date.now() / 86_400_000);
  return TIPS[day % TIPS.length]!;
}

/** A random tip (for /tip on demand). */
export function randomTip(seed: number): string {
  return TIPS[Math.abs(seed) % TIPS.length]!;
}

export interface QuizItem {
  scenario: string;
  answer: 'red' | 'fine';
  explain: string;
}

/** "Red flag or fine?" — a 30-second daily game. Scenario → red/fine → why. */
export const QUIZ: QuizItem[] = [
  { scenario: 'Three days in, they say "I’ve never felt this way, I think you’re the one." 💕', answer: 'red', explain: 'Love-bombing. Real feelings that fast are rare — this is often used to fast-track your trust.' },
  { scenario: 'They ask to move from the dating app to text within the first two messages. 📱', answer: 'red', explain: 'Moving off-app fast is a scammer favorite — it dodges the platform’s safety tools and paper trail.' },
  { scenario: 'They suggest meeting for coffee at a busy café Saturday afternoon. ☕', answer: 'fine', explain: 'Public, daytime, low-pressure. This is exactly how a safe first meet should look.' },
  { scenario: 'Their camera "never works" so they can’t video-call before you meet. 📹', answer: 'red', explain: 'The single biggest catfish tell. A 30-second live call clears it up — dodging it doesn’t.' },
  { scenario: 'They mention a can’t-miss crypto investment their "uncle" runs. 📈', answer: 'red', explain: 'Pig-butchering scam. Any investment/money talk from someone you met online = walk away.' },
  { scenario: 'They post regularly, have tagged friends, and a years-old account. 📸', answer: 'fine', explain: 'A real, established footprint is a green flag — hard to fake years of tagged history.' },
  { scenario: 'They only ever text between 1–4pm on weekdays and vanish on weekends. ⏰', answer: 'red', explain: 'Classic "I have another life" pattern — often a partner they’re not telling you about.' },
  { scenario: 'They answer specific questions about their job with real, checkable detail. 💼', answer: 'fine', explain: 'Specificity is honesty’s friend. Liars get vague; this reads as the real thing.' },
  { scenario: 'Two weeks in, they’re still not on any of their socials and you’ve met no one. 👤', answer: 'red', explain: 'Pocketing — you’re being hidden. Worth asking why, directly.' },
  { scenario: 'They say "don’t tell your friends about us, keep it special." 🤫', answer: 'red', explain: 'Secrecy protects the person with something to hide. Your friends are a feature, not a bug.' },
  { scenario: 'They’re fine going at your pace and never guilt-trip a "not yet." 🐢', answer: 'fine', explain: 'Respecting your timeline and your no is exactly what a safe person does.' },
  { scenario: 'A sudden "family emergency" comes with a request for a small loan. 🚑', answer: 'red', explain: 'The oldest script in the book. Emergency + money ask = scam, almost every time.' },
];

/** A quiz item picked by index (stable id = its position). */
export function quizAt(i: number): QuizItem | undefined {
  return QUIZ[i];
}
export function randomQuizIndex(seed: number): number {
  return Math.abs(seed) % QUIZ.length;
}
