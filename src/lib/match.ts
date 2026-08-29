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
 * Years of experience the fact bank actually supports.
 *
 * The bank has no explicit "N years" fact, so this is derived from the start
 * date stated in the role fact and nothing else. It reads conservatively on
 * purpose — inferring a larger number by stitching overlapping facts together
 * would be inventing experience, which is the one thing this app must not do.
 */
export function candidateYears(facts: Fact[], now = new Date()): { years: number | null; basis: string } {
  const role = facts.find((f) => f.kind === 'role' && /\b(19|20)\d{2}\b/.test(f.text))
  if (!role) return { years: null, basis: 'no role fact states a start date' }

  const match = role.text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\b/i,
  )
  if (!match) return { years: null, basis: `no month/year found in ${role.id}` }

  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ]
  const start = new Date(Number(match[2]), months.indexOf(match[1].toLowerCase()), 1)
  const elapsed = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth())
  return {
    years: Math.max(0, Math.floor(elapsed / 12)),
    basis: `${match[1]} ${match[2]} start stated in ${role.id}`,
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

  const { years, basis } = candidateYears(facts, now)
  const yearsGap = job.minYears === null || years === null ? null : Math.max(0, job.minYears - years)

  return { covered, missing, yearsGap, yearsBasis: basis, candidateYears: years }
}

/** The three requirement groups, derived from tags — never parsed a second time. */
export function groupTags(job: Job) {
  return {
    requiredTags: job.tags.filter((t) => t.required === true),
    niceToHaveTags: job.tags.filter((t) => t.required === false),
    unclassifiedTags: job.tags.filter((t) => t.required === null),
  }
}
