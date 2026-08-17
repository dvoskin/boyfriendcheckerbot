/** What the user asked us to look up. One query can carry several selectors. */
export interface Subject {
  raw: string;
  kind: SubjectKind;
  /** Normalised value, e.g. lowercased handle without the leading @. */
  value: string;
  /** Optional extra context the user supplied, e.g. "Miami FL". */
  hints?: string;
}

export type SubjectKind =
  | 'username'
  | 'email'
  | 'domain'
  | 'person'
  | 'company'
  | 'phone'
  | 'image';

/**
 * A single atomic claim, always carrying its provenance. Every fact we show a
 * user must be traceable to a source and a retrieval time — that is both the
 * product's credibility and the paper trail if the search is ever disputed.
 */
export interface Finding {
  source: string;
  /** Short label shown in the report, e.g. "GitHub" or "NPPES". */
  label: string;
  title: string;
  detail?: string;
  url?: string;
  /** ISO timestamp of when WE retrieved it, not when the data was authored. */
  retrievedAt: string;
  /** 0–1. Below 0.5 renders as "possible match" rather than a statement. */
  confidence: number;
  extra?: Record<string, unknown>;
}

export interface SourceResult {
  source: string;
  label: string;
  ok: boolean;
  findings: Finding[];
  /** Populated when ok === false. Shown to the user so gaps are never silent. */
  error?: string;
  ms: number;
  /** True when the source was skipped because a key or budget was missing. */
  skipped?: boolean;
}

export interface Source {
  id: string;
  label: string;
  /** Which selector kinds this source can act on. */
  accepts: SubjectKind[];
  /**
   * Return null to opt out of this particular subject (e.g. no API key set).
   * Throw to report a hard failure — the runner catches and records it.
   */
  run(subject: Subject, ctx: SourceContext): Promise<Finding[] | null>;
}

export interface SourceContext {
  now: string;
  /** Free-text location/context hint from the user, if any. */
  hints?: string;
  /** Raw bytes, only present for image subjects. */
  imageBuffer?: Buffer;
}
