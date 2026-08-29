/**
 * Pure matching logic. Both the UI and the WebMCP tools call these — there is no
 * second implementation anywhere, which is what keeps a tool from being able to
 * do something a button cannot.
 */
import vocabulary from '../data/vocabulary.json'
import type { Fact, FitGaps, Filters, Job } from '../types'

const ALIAS_TO_CANONICAL = vocabulary.aliasToCanonical as Record<string, string>

/**
 * Resolve any surface form — a fact token, a job tag, a typed query — to its
 * canonical vocabulary name. Returns null when the term is outside the
 * vocabulary, which is a real answer: the app must not claim anything about it.
 *
 * This is the whole point of the alias layer. The market writes "TTS"; this
 * profile writes "text to speech". Comparing those literally reports a gap the
 * candidate does not have.
 */
export function resolveToken(token: string | null | undefined): string | null {
  if (!token) return null
  return ALIAS_TO_CANONICAL[String(token).trim().toLowerCase()] ?? null
}

/** canonical tag -> the fact ids that can evidence it. */
export function profileCoverage(facts: Fact[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const fact of facts) {
    for (const token of fact.tokens) {
      const canonical = resolveToken(token)
      if (!canonical) continue
      const ids = out.get(canonical)
      if (ids) {
        if (!ids.includes(fact.id)) ids.push(fact.id)
      } else {
        out.set(canonical, [fact.id])
      }
    }
  }
  return out
}

export function applyFilters(jobs: Job[], filters: Filters): Job[] {
  const query = filters.query.trim().toLowerCase()
  return jobs.filter((job) => {
    if (filters.remote !== null && job.remote !== filters.remote) return false
    if (filters.seniority !== null && job.seniority !== filters.seniority) return false
    if (filters.maxYears !== null && job.minYears !== null && job.minYears > filters.maxYears) return false
    if (filters.tags.length > 0) {
      // Tag filters resolve through the same table, so filtering by "tts" finds
      // the jobs tagged "speech".
      const wanted = filters.tags.map((t) => resolveToken(t) ?? t.toLowerCase())
      if (!wanted.every((t) => job.tagNames.includes(t))) return false
    }
    if (query) {
      const hay = `${job.title} ${job.company} ${job.description} ${job.tagNames.join(' ')}`.toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  })
}

/**
 * Years of experience.
 *
 * This is read from an explicit fact, not inferred in code. The number is a
 * claim the candidate owns, carrying the same provenance as every other claim,
 * and `basis` is the fact's own words so a reader can judge it rather than
 * being handed a bare integer.
 *
 * Falling back to a date subtraction — which is what this used to do — produced
 * a technically defensible but practically false 0, because a start date says
 * nothing about the work that preceded it. Where no explicit fact exists the
 * fallback still runs, but it labels itself as derived so the difference is
 * visible.
 */
export function candidateYears(
  facts: Fact[],
  now = new Date(),
): { years: number | null; basis: string; factId: string | null } {
  // An explicit experience fact: a token of the form "N years".
  for (const fact of facts) {
    for (const token of fact.tokens) {
      const m = token.match(/^(\d+(?:\.\d+)?)\s*(?:\+\s*)?years?$/i)
      if (m) return { years: Math.floor(Number(m[1])), basis: fact.text, factId: fact.id }
    }
  }

  const role = facts.find((f) => f.kind === 'role' && /\b(19|20)\d{2}\b/.test(f.text))
  const match = role?.text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\b/i,
  )
  if (!role || !match) {
    return { years: null, basis: 'No fact states years of experience.', factId: null }
  }

  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ]
  const start = new Date(Number(match[2]), months.indexOf(match[1].toLowerCase()), 1)
  const elapsed = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth())
  return {
    years: Math.max(0, Math.floor(elapsed / 12)),
    basis: `Derived from the ${match[1]} ${match[2]} start date in ${role.id}; `
      + 'no fact states total years of experience, so earlier work is not counted.',
    factId: role.id,
  }
}

/**
 * Deterministic, app-computed comparison. No language-model judgement is
 * involved, which is what makes the agent's later claims checkable.
 */
export function computeFitGaps(job: Job, facts: Fact[], now = new Date()): FitGaps {
  const coverage = profileCoverage(facts)
  const covered: FitGaps['covered'] = []
  const missing: string[] = []

  for (const tag of job.tagNames) {
    const factIds = coverage.get(tag)
    if (factIds && factIds.length > 0) covered.push({ tag, factIds })
    else missing.push(tag)
  }

  const { years, basis, factId } = candidateYears(facts, now)
  const yearsGap = job.minYears === null || years === null ? null : Math.max(0, job.minYears - years)

  const total = covered.length + missing.length
  const ratio = total === 0 ? 0 : covered.length / total

  // A short years count must not be allowed to stand in for the whole fit. When
  // coverage is strong the verdict says so, because reducing a candidate to one
  // failing number is the same error as inflating him with a false one.
  let verdict: string
  if (yearsGap === null) {
    verdict = `${covered.length} of ${total} requirements evidenced. The posting states no minimum years.`
  } else if (yearsGap === 0) {
    verdict = `${covered.length} of ${total} requirements evidenced, and the stated years are met.`
  } else if (ratio >= 0.6) {
    verdict = `${covered.length} of ${total} requirements evidenced — strong coverage — but ${yearsGap} year`
      + `${yearsGap === 1 ? '' : 's'} short of the ${job.minYears} the posting asks for. `
      + 'Lead with the evidenced work; do not restate the years.'
  } else {
    verdict = `${covered.length} of ${total} requirements evidenced, and ${yearsGap} year`
      + `${yearsGap === 1 ? '' : 's'} short of the ${job.minYears} the posting asks for.`
  }

  return {
    covered, missing, yearsGap,
    yearsBasis: basis, candidateYears: years, yearsFactId: factId,
    coverageRatio: Number(ratio.toFixed(2)),
    verdict,
  }
}

/** The three requirement groups, derived from tags — never parsed a second time. */
export function groupTags(job: Job) {
  return {
    requiredTags: job.tags.filter((t) => t.required === true),
    niceToHaveTags: job.tags.filter((t) => t.required === false),
    unclassifiedTags: job.tags.filter((t) => t.required === null),
  }
}
