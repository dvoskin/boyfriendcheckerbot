import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * EDGAR full-text search covers filings from 2001 onward and indexes the *body*
 * of documents, not just filer names. That makes it the cheapest way to find a
 * private individual attached to a company: Form D filings name the executive
 * officers and promoters of private placements, and proxies name directors.
 *
 * No API key. SEC requires a declared User-Agent with a contact address and
 * enforces roughly 10 requests/second — both handled centrally in core/http.
 */
const FTS = 'https://efts.sec.gov/LATEST/search-index';

interface FtsHit {
  _id: string;
  _source: {
    file_date?: string;
    display_names?: string[];
    file_type?: string;
    root_form?: string;
    adsh?: string;
  };
}

interface FtsResponse {
  hits?: {
    total?: { value?: number };
    hits?: FtsHit[];
  };
}

/** Build the human-facing URL for a filing out of the FTS composite id. */
function filingUrl(id: string, cik?: string): string {
  const [accession, file] = id.split(':');
  if (!accession) return 'https://efts.sec.gov/LATEST/search-index';
  const noDashes = accession.replace(/-/g, '');
  if (cik && file) {
    return `https://www.sec.gov/Archives/edgar/data/${cik}/${noDashes}/${file}`;
  }
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${accession}`;
}

function cikFromDisplayName(name: string | undefined): string | undefined {
  const m = /\(CIK (\d{10})\)/.exec(name ?? '');
  return m?.[1]?.replace(/^0+/, '');
}

export const secSource: Source = {
  id: 'sec',
  label: 'SEC EDGAR',
  accepts: ['person', 'company', 'domain'],

  async run(subject, ctx) {
    // Quoted phrase search — unquoted terms match far too broadly to be useful.
    const q = `"${subject.value.replace(/"/g, '')}"`;
    const url = `${FTS}?q=${encodeURIComponent(q)}&forms=D,4,8-K,10-K,S-1,DEF%2014A`;

    const res = await httpJson<FtsResponse>(url, {
      timeoutMs: 9000,
      cacheTtl: 21_600,
      headers: { Accept: 'application/json' },
    });

    const hits = res.hits?.hits ?? [];
    if (hits.length === 0) return [];

    const total = res.hits?.total?.value ?? hits.length;
    const findings: Finding[] = [
      {
        source: 'sec',
        label: 'SEC EDGAR',
        title: `${total} EDGAR filings mention "${subject.value}"`,
        detail: 'Full-text search across filings from 2001 onward.',
        url: `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}`,
        retrievedAt: ctx.now,
        confidence: 0.85,
      },
    ];

    for (const hit of hits.slice(0, 6)) {
      const src = hit._source;
      const filer = src.display_names?.[0];
      const cik = cikFromDisplayName(filer);
      findings.push({
        source: 'sec',
        label: `EDGAR ${src.root_form ?? src.file_type ?? 'filing'}`,
        title: filer ?? hit._id,
        detail: [
          src.root_form && `Form: ${src.root_form}`,
          src.file_date && `Filed: ${src.file_date}`,
          // Form D is the high-value one: it lists related persons — executive
          // officers, directors and promoters — of otherwise private companies.
          src.root_form === 'D' && 'Form D lists related persons of a private offering',
        ]
          .filter(Boolean)
          .join('\n'),
        url: filingUrl(hit._id, cik),
        retrievedAt: ctx.now,
        confidence: 0.7,
        extra: { cik },
      });
    }

    return findings;
  },
};
