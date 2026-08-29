/**
 * One store module. Every UI action and every tool `execute` goes through the
 * action functions below — if a tool can do something no button can, that is a
 * bug, and the only way to guarantee it is to have a single implementation.
 *
 * This is a module-level store read through useSyncExternalStore rather than a
 * context + useReducer pair. The tools are registered outside React's tree and
 * must see current state whenever the agent calls them; a plain module store
 * gives them that directly instead of routing through refs that can go stale.
 * useSyncExternalStore is part of React itself — no state library was added.
 */
import jobsData from './data/jobs.json'
import factsData from './data/profile-facts.json'
import resumeData from './data/resume.json'
import { applyFilters, computeFitGaps, groupTags } from './lib/match'
import type {
  Application, Fact, FactKind, Filters, Job, ResumeBlock, ResumeSection,
} from './types'
import { EMPTY_FILTERS } from './types'

export const JOBS = jobsData.jobs as Job[]
export const FACTS = factsData.facts as Fact[]
export const PROFILE = factsData.profile
export const ATTRIBUTION = jobsData.attribution

/** Tool scope, per docs/TOOL_CONTRACT.md §5. */
export const ALWAYS_TOOLS = [
  'get_workspace_state', 'get_profile_facts', 'get_resume',
  'get_applications', 'search_jobs', 'open_job',
] as const

export const JOB_SCOPED_TOOLS = ['get_job_details', 'get_fit_gaps'] as const

export type State = {
  filters: Filters
  openJobId: string | null
  resume: ResumeBlock[]
  applications: Application[]
  /** 'active' once registerTool has been found and used; never faked. */
  webmcp: 'unsupported' | 'active'
}

let state: State = {
  filters: EMPTY_FILTERS,
  openJobId: null,
  resume: resumeData.blocks as ResumeBlock[],
  applications: [],
  webmcp: 'unsupported',
}

const listeners = new Set<() => void>()

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getState() { return state }

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  for (const fn of listeners) fn()
}

// ---------------------------------------------------------------- derived

export function visibleJobs(s: State = state): Job[] {
  return applyFilters(JOBS, s.filters)
}

export function openJob(s: State = state): Job | null {
  return s.openJobId ? JOBS.find((j) => j.id === s.openJobId) ?? null : null
}

/** The tool names in scope right now. Derived from state, so it cannot drift. */
export function toolsInScope(s: State = state): string[] {
  return s.openJobId ? [...ALWAYS_TOOLS, ...JOB_SCOPED_TOOLS] : [...ALWAYS_TOOLS]
}

const err = (error: string, hint: string) => ({ ok: false as const, error, hint })

// ---------------------------------------------------------------- actions

export function setFilters(next: Filters) {
  set({ filters: next })
}

export function patchFilters(patch: Partial<Filters>) {
  set({ filters: { ...state.filters, ...patch } })
}

export function resetFilters() {
  set({ filters: EMPTY_FILTERS })
}

export function setWebmcpStatus(status: State['webmcp']) {
  if (state.webmcp !== status) set({ webmcp: status })
}

const jobSummary = (j: Job) => ({
  id: j.id,
  title: j.title,
  company: j.company,
  remote: j.remote,
  seniority: j.seniority,
  minYears: j.minYears,
  tags: j.tagNames,
})

/**
 * Replaces the whole filter set rather than merging — the agent passes its full
 * intended state each call, which keeps behaviour predictable across turns.
 */
export function searchJobs(input: Partial<Filters> & { limit?: number } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 25)
  const next: Filters = {
    query: input.query ?? '',
    remote: input.remote ?? null,
    seniority: input.seniority ?? null,
    maxYears: input.maxYears ?? null,
    tags: input.tags ?? [],
  }
  setFilters(next)
  const matches = applyFilters(JOBS, next)
  return {
    summary: `${matches.length} job${matches.length === 1 ? '' : 's'} match. Showing ${Math.min(limit, matches.length)}. Filters are now visible in the sidebar.`,
    matchCount: matches.length,
    jobs: matches.slice(0, limit).map(jobSummary),
  }
}

export function selectJob(jobId: string) {
  const job = JOBS.find((j) => j.id === jobId)
  if (!job) {
    return err('job_not_found', `No job with id "${jobId}". Call search_jobs first and use an id from its results.`)
  }
  set({ openJobId: jobId })
  return {
    ok: true as const,
    summary: `Opened "${job.title}" at ${job.company}. ${JOB_SCOPED_TOOLS.length} more tools are now available.`,
    job: jobSummary(job),
    newlyAvailableTools: [...JOB_SCOPED_TOOLS],
  }
}

export function closeJob() {
  if (!state.openJobId) return
  set({ openJobId: null })
}

export function getWorkspaceState() {
  const matches = visibleJobs()
  const job = openJob()
  const counts = { draft: 0, ready: 0, submitted: 0 }
  for (const a of state.applications) counts[a.status]++
  return {
    summary: `Job list showing ${matches.length} of ${JOBS.length} jobs.`
      + (job ? ` '${job.title} at ${job.company}' is open.` : ' No job is open.')
      + ` ${toolsInScope().length} tools registered.`,
    activeFilters: state.filters,
    visibleJobCount: matches.length,
    totalJobCount: JOBS.length,
    openJobId: state.openJobId,
    registeredTools: toolsInScope(),
    pendingEditCount: 0,
    applicationCounts: counts,
  }
}

export function getProfileFacts(kind?: FactKind) {
  const facts = kind ? FACTS.filter((f) => f.kind === kind) : FACTS
  const byKind: Record<string, number> = {}
  for (const f of facts) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
  const breakdown = Object.entries(byKind).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ')
  return {
    summary: `${facts.length} facts on file: ${breakdown}.`,
    facts: facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text, tokens: f.tokens })),
  }
}

export function getResume(section?: ResumeSection) {
  const blocks = section ? state.resume.filter((b) => b.section === section) : state.resume
  return {
    summary: `${blocks.length} resume block${blocks.length === 1 ? '' : 's'}`
      + (section ? ` in "${section}".` : ' across summary, experience, skills and education.')
      + ' Untailored baseline.',
    tailoredForJobId: null,
    blocks,
  }
}

export function getApplications(status?: Application['status']) {
  const rows = status ? state.applications.filter((a) => a.status === status) : state.applications
  return {
    summary: rows.length === 0
      ? 'No applications yet.'
      : `${rows.length} application${rows.length === 1 ? '' : 's'}.`,
    applications: rows,
  }
}

export function getJobDetails() {
  const job = openJob()
  if (!job) return err('no_job_open', 'Call open_job first — this tool reads the currently open posting.')
  const { requiredTags, niceToHaveTags, unclassifiedTags } = groupTags(job)
  const strip = (t: { tag: string; evidence: string }) => ({ tag: t.tag, evidence: t.evidence })
  return {
    ok: true as const,
    summary: `${job.title} at ${job.company}. `
      + `${requiredTags.length} required, ${niceToHaveTags.length} nice-to-have, ${unclassifiedTags.length} unclassified.`,
    job: { ...jobSummary(job), location: job.location, postedAt: job.postedAt, source: job.source, url: job.url },
    description: job.description,
    descriptionTruncated: true,
    requiredTags: requiredTags.map(strip),
    niceToHaveTags: niceToHaveTags.map(strip),
    unclassifiedTags: unclassifiedTags.map(strip),
    minYears: job.minYears,
  }
}

export function getFitGaps() {
  const job = openJob()
  if (!job) return err('no_job_open', 'Call open_job first — this tool compares the open posting against the fact bank.')
  const gaps = computeFitGaps(job, FACTS)
  const total = gaps.covered.length + gaps.missing.length
  return {
    ok: true as const,
    summary: `Covered ${gaps.covered.length} of ${total} requirements.`
      + (gaps.missing.length ? ` Missing: ${gaps.missing.join(', ')}.` : ' Nothing missing.'),
    covered: gaps.covered,
    missing: gaps.missing,
    yearsGap: gaps.yearsGap,
    candidateYears: gaps.candidateYears,
    yearsBasis: gaps.yearsBasis,
  }
}
