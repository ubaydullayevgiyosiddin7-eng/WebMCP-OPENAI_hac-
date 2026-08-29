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
import { checkEdit } from './lib/guard'
import { applyFilters, computeFitGaps, groupTags } from './lib/match'
import type {
  Application, EditProposal, Fact, FactKind, FactRequest, Filters, GuardFailure,
  Job, PendingEdit, ResumeBlock, ResumeSection,
} from './types'
import { EMPTY_FILTERS } from './types'

export const JOBS = jobsData.jobs as Job[]
/** Initial fact bank. Live facts live in state — the human can add one. */
export const FACTS = factsData.facts as Fact[]
export const PROFILE = factsData.profile
export const ATTRIBUTION = jobsData.attribution

/** Tool scope, per docs/TOOL_CONTRACT.md §5. */
export const ALWAYS_TOOLS = [
  'get_workspace_state', 'get_profile_facts', 'get_resume',
  'get_applications', 'search_jobs', 'open_job', 'request_profile_fact',
] as const

export const JOB_SCOPED_TOOLS = [
  'get_job_details', 'get_fit_gaps', 'propose_resume_edits',
] as const

/** Registered only while at least one edit is pending (contract §5). */
export const EDIT_SCOPED_TOOLS = ['withdraw_edit'] as const

export type State = {
  filters: Filters
  openJobId: string | null
  facts: Fact[]
  resume: ResumeBlock[]
  pendingEdits: PendingEdit[]
  factRequest: FactRequest | null
  applications: Application[]
  /** 'active' once registerTool has been found and used; never faked. */
  webmcp: 'unsupported' | 'active'
}

let state: State = {
  filters: EMPTY_FILTERS,
  openJobId: null,
  facts: FACTS,
  resume: resumeData.blocks as ResumeBlock[],
  pendingEdits: [],
  factRequest: null,
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
  const names: string[] = [...ALWAYS_TOOLS]
  if (s.openJobId) names.push(...JOB_SCOPED_TOOLS)
  if (s.pendingEdits.some((e) => e.status === 'pending')) names.push(...EDIT_SCOPED_TOOLS)
  return names
}

export const pendingEdits = (s: State = state) => s.pendingEdits.filter((e) => e.status === 'pending')

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
  const facts = kind ? state.facts.filter((f) => f.kind === kind) : state.facts
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
  const gaps = computeFitGaps(job, state.facts)
  return {
    ok: true as const,
    summary: gaps.verdict
      + (gaps.missing.length ? ` Missing: ${gaps.missing.join(', ')}.` : ' Nothing missing.'),
    covered: gaps.covered,
    missing: gaps.missing,
    yearsGap: gaps.yearsGap,
    candidateYears: gaps.candidateYears,
    yearsBasis: gaps.yearsBasis,
    yearsFactId: gaps.yearsFactId,
    coverageRatio: gaps.coverageRatio,
    verdict: gaps.verdict,
  }
}

// ---------------------------------------------------------------- phase 2

let editSeq = 0

/**
 * Queues reviewable diffs. It NEVER mutates the resume — that is the whole
 * contract. Each edit is put through the fact guard first; anything that fails
 * comes back as a structured refusal naming the tokens, so the agent can
 * correct itself rather than retry blindly.
 */
export function proposeResumeEdits(edits: EditProposal[]) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return err('no_edits', 'Pass at least one edit. Each needs targetBlockId, newText, rationale and sourceFactIds.')
  }
  if (edits.length > 8) {
    return err('too_many_edits', 'At most 8 edits per call. Split them across turns so the human can review.')
  }

  const queued: { editId: string; targetBlockId: string }[] = []
  const rejected: GuardFailure[] = []
  const accepted: PendingEdit[] = []

  for (const proposal of edits) {
    const failure = checkEdit(proposal, state.resume, state.facts)
    if (failure) { rejected.push(failure); continue }

    const block = state.resume.find((b) => b.id === proposal.targetBlockId)!
    const id = `e_${++editSeq}`
    accepted.push({
      ...proposal,
      id,
      jobId: state.openJobId,
      before: block.text,
      after: proposal.newText,
      status: 'pending',
    })
    queued.push({ editId: id, targetBlockId: proposal.targetBlockId })
  }

  if (accepted.length > 0) set({ pendingEdits: [...state.pendingEdits, ...accepted] })

  const parts = [`${queued.length} of ${edits.length} edit${edits.length === 1 ? '' : 's'} queued for review.`]
  if (rejected.length > 0) {
    parts.push(`${rejected.length} rejected: ${rejected.map((r) => r.offendingTokens.join('/') || r.reason).join('; ')}.`)
  }

  return { ok: true as const, summary: parts.join(' '), queued, rejected }
}

export function withdrawEdit(editId: string) {
  const edit = state.pendingEdits.find((e) => e.id === editId)
  if (!edit) return err('edit_not_found', `No edit "${editId}". Call get_workspace_state to see pending edit ids.`)
  if (edit.status !== 'pending') {
    return err('edit_not_pending', `Edit "${editId}" is already ${edit.status} and cannot be withdrawn.`)
  }
  set({ pendingEdits: state.pendingEdits.filter((e) => e.id !== editId) })
  return { ok: true as const, summary: `Withdrew ${editId}.`, withdrawnId: editId }
}

/** Human-only. The agent has no path to this. */
export function acceptEdit(editId: string) {
  const edit = state.pendingEdits.find((e) => e.id === editId)
  if (!edit) return
  set({
    resume: state.resume.map((b) => (b.id === edit.targetBlockId ? { ...b, text: edit.after } : b)),
    pendingEdits: state.pendingEdits.filter((e) => e.id !== editId),
  })
}

/** Human-only. Removing it frees the agent to propose different wording. */
export function rejectEdit(editId: string) {
  set({ pendingEdits: state.pendingEdits.filter((e) => e.id !== editId) })
}

/**
 * The agent may never write to the fact bank. This only opens a pre-filled
 * panel; the human saves, edits or dismisses it.
 */
export function requestProfileFact(req: FactRequest) {
  if (!req?.claim || !req?.kind) {
    return err('bad_request', 'Pass claim, kind and why. The user sees the claim pre-filled and decides.')
  }
  set({ factRequest: { claim: String(req.claim), kind: req.kind, why: String(req.why ?? '') } })
  return {
    ok: true as const,
    summary: `Asked the user to confirm: "${req.claim}". Nothing was added — continue, and re-read get_profile_facts later.`,
    status: 'awaiting_user' as const,
  }
}

/** Human-only: commit the pending request as a real fact. */
export function saveFactRequest(claim: string, kind: Fact['kind'], tokens: string[]) {
  const id = `f_user_${state.facts.length + 1}`
  set({
    facts: [...state.facts, { id, kind, text: claim, tokens }],
    factRequest: null,
  })
  return id
}

export function dismissFactRequest() {
  set({ factRequest: null })
}
