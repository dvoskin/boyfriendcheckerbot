import type { Source, SourceContext, SourceResult, Subject } from './types.js';

/**
 * Hard ceiling for one lookup. Sources still running at this point are reported
 * as timed out rather than allowed to hang the reply — a partial answer that
 * arrives is worth more than a complete one that never does.
 */
const GLOBAL_DEADLINE_MS = 12_000;

export interface RunOptions {
  /** Called as each source settles, so the caller can stream partial results. */
  onResult?: (result: SourceResult) => void;
  deadlineMs?: number;
}

/**
 * Fan out to every source that accepts this subject, all at once. Total latency
 * is the slowest source, not the sum, and the onResult callback lets the UI show
 * hits the moment they land instead of after the last straggler.
 */
export async function runSources(
  sources: Source[],
  subject: Subject,
  ctx: SourceContext,
  opts: RunOptions = {},
): Promise<SourceResult[]> {
  const applicable = sources.filter((s) => s.accepts.includes(subject.kind));
  const deadline = opts.deadlineMs ?? GLOBAL_DEADLINE_MS;

  const tasks = applicable.map(async (source): Promise<SourceResult> => {
    const started = Date.now();
    try {
      const findings = await withDeadline(source.run(subject, ctx), deadline);
      const result: SourceResult = {
        source: source.id,
        label: source.label,
        ok: true,
        findings: findings ?? [],
        skipped: findings === null,
        ms: Date.now() - started,
      };
      opts.onResult?.(result);
      return result;
    } catch (err) {
      const result: SourceResult = {
        source: source.id,
        label: source.label,
        ok: false,
        findings: [],
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      };
      opts.onResult?.(result);
      return result;
    }
  });

  return Promise.all(tasks);
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
