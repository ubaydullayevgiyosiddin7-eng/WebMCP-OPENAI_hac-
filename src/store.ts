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
import { checkCoverNote, checkEdit, sourceSpread } from './lib/guard'
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

/** Job open AND zero pending edits — the ordering rule, expressed as scope. */
export const PREPARE_SCOPED_TOOLS = ['prepare_application'] as const

/** Only once an application is ready to send. */
export const SUBMIT_SCOPED_TOOLS = ['submit_application'] as const

export type State = {
  filters: Filters
  openJobId: string | null
  facts: Fact[]
  resume: ResumeBlock[]
  pendingEdits: PendingEdit[]
  factRequest: FactRequest | null
  applications: Application[]
  /** The application the confirmation modal is currently showing, if any. */
  submitModalFor: string | null
  /** 'active' once registerTool has been found and used; never faked. */
  webmcp: 'unsupported' | 'active'
}

/** Resolver for the open confirmation modal. Null when no modal is showing. */
let submitResolver: ((confirmed: boolean) => void) | null = null

const STORAGE_KEY = 'tailor.v1'

/** The shipped demo data. A first visit always lands on this, never on nothing. */
const DEFAULTS = () => ({
  facts: FACTS.map((f) => ({ ...f })),
  resume: (resumeData.blocks as ResumeBlock[]).map((b) => ({ ...b })),
  applications: [] as Application[],
})

/**
 * Only the parts a human can change are persisted. Jobs, and the baseline
 * profile and resume, ship in the bundle — so an empty localStorage still gives
 * a complete working app rather than an empty one.
 */
function loadPersisted() {
  const d = DEFAULTS()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return d
    const parsed = JSON.parse(raw)
    return {
      facts: Array.isArray(parsed.facts) && parsed.facts.length > 0 ? parsed.facts as Fact[] : d.facts,
      resume: Array.isArray(parsed.resume) && parsed.resume.length > 0 ? parsed.resume as ResumeBlock[] : d.resume,
      applications: Array.isArray(parsed.applications) ? parsed.applications as Application[] : d.applications,
    }
  } catch {
    // Corrupt or unavailable storage must never produce a broken page.
    return d
  }
}

/**
 * A judge arriving at a URL someone else already used would otherwise inherit
 * their state. ?reset=1 guarantees a clean slate without touching the keyboard,
 * and strips itself from the address bar so a later reload is a normal visit.
 */
function consumeResetParam(): boolean {
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get('reset') !== '1') return false
    localStorage.removeItem(STORAGE_KEY)
    url.searchParams.delete('reset')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    return true
  } catch {
    return false
  }
}

consumeResetParam()
const persisted = loadPersisted()

let state: State = {
  filters: EMPTY_FILTERS,
  openJobId: null,
  facts: persisted.facts,
  resume: persisted.resume,
  pendingEdits: [],
  factRequest: null,
  applications: persisted.applications,
  submitModalFor: null,
  webmcp: 'unsupported',
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      facts: state.facts,
      resume: state.resume,
      applications: state.applications,
    }))
  } catch { /* private mode or quota — not worth breaking the page over */ }
}

const listeners = new Set<() => void>()

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getState() { return state }

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  persist()
  for (const fn of listeners) fn()
}

/** True once the visitor has changed anything away from the shipped demo. */
export function hasCustomState(s: State = state): boolean {
  const base = resumeData.blocks as ResumeBlock[]
  return s.applications.length > 0
    || s.facts.length !== FACTS.length
    || s.resume.some((b, i) => b.text !== base[i]?.text)
}

/** Visible control: put the demo back exactly as a judge first found it. */
export function resetDemoData() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  submitResolver = null
  set({
    ...DEFAULTS(),
    filters: EMPTY_FILTERS,
    openJobId: null,
    pendingEdits: [],
    factRequest: null,
    submitModalFor: null,
  })
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
  const hasPending = s.pendingEdits.some((e) => e.status === 'pending')
  if (s.openJobId) names.push(...JOB_SCOPED_TOOLS)
  if (hasPending) names.push(...EDIT_SCOPED_TOOLS)
  if (s.openJobId && !hasPending) names.push(...PREPARE_SCOPED_TOOLS)
  if (s.applications.some((a) => a.status === 'ready')) names.push(...SUBMIT_SCOPED_TOOLS)
  return names
}

export const pendingEdits = (s: State = state) => s.pendingEdits.filter((e) => e.status === 'pending')


/**
 * The condition under which each scoped tool exists. Phrased as a requirement so
 * it reads correctly when a tool goes away — an agent that finds a tool missing
 * has nothing to read unless we say what it needs, and "it vanished" is not a
 * debuggable state.
 */
const SCOPE_REQUIRES: Record<string, string> = {
  get_job_details: 'a job to be open',
  get_fit_gaps: 'a job to be open',
  propose_resume_edits: 'a job to be open',
  withdraw_edit: 'at least one edit pending review',
  prepare_application: 'a job open and no edits pending review',
  submit_application: 'a prepared application',
}

/**
 * Diff the registered tool surface across an action and describe it in words.
 * Every scope-changing action returns this, so the agent is never left to
 * discover a change by failing.
 */
function scopeDelta(before: string[]) {
  const after = toolsInScope()
  const toolsAdded = after.filter((t) => !before.includes(t))
  const toolsRemoved = before.filter((t) => !after.includes(t))

  const parts: string[] = []
  if (toolsAdded.length) {
    parts.push(`Now available: ${toolsAdded.join(', ')}.`)
  }
  if (toolsRemoved.length) {
    parts.push(`No longer available: ${toolsRemoved
      .map((n) => (SCOPE_REQUIRES[n] ? `${n} (needs ${SCOPE_REQUIRES[n]})` : n))
      .join(', ')}.`)
  }

  return { toolsAdded, toolsRemoved, registeredTools: after, scopeNote: parts.join(' ') }
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
  const before = toolsInScope()
  const job = JOBS.find((j) => j.id === jobId)
  if (!job) {
    return err('job_not_found', `No job with id "${jobId}". Call search_jobs first and use an id from its results.`)
  }
  set({ openJobId: jobId })
  const delta = scopeDelta(before)
  return {
    ok: true as const,
    summary: `Opened "${job.title}" at ${job.company}. ${delta.scopeNote}`,
    job: jobSummary(job),
    newlyAvailableTools: delta.toolsAdded,
    ...delta,
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
      + (pendingEdits().length
        ? ` ${pendingEdits().length} edit${pendingEdits().length === 1 ? ' awaits' : 's await'} your review — `
          + 'prepare_application stays unregistered until they are cleared.'
        : '')
      + ` ${toolsInScope().length} tools registered.`,
    activeFilters: state.filters,
    visibleJobCount: matches.length,
    totalJobCount: JOBS.length,
    openJobId: state.openJobId,
    registeredTools: toolsInScope(),
    pendingEditCount: pendingEdits().length,
    pendingEditIds: pendingEdits().map((e) => e.id),
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
  const counts = { draft: 0, ready: 0, submitted: 0 }
  for (const a of state.applications) counts[a.status]++
  return {
    summary: rows.length === 0
      ? 'No applications yet.'
      : `${rows.length} application${rows.length === 1 ? '' : 's'}: `
        + `${counts.draft} draft, ${counts.ready} ready, ${counts.submitted} submitted.`,
    applications: rows.map((a) => ({
      jobId: a.jobId,
      jobTitle: JOBS.find((j) => j.id === a.jobId)?.title ?? a.jobId,
      company: JOBS.find((j) => j.id === a.jobId)?.company ?? '',
      status: a.status,
      submittedAt: a.submittedAt,
      coverNote: a.coverNote,
      blockCount: a.resumeSnapshot.length,
    })),
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
      + `${requiredTags.length} required, ${niceToHaveTags.length} nice-to-have, ${unclassifiedTags.length} unclassified.`
      + (requiredTags.length > 8 ? ' Call get_fit_gaps before working through them — it says which are already covered.' : ''),
    job: { ...jobSummary(job), location: job.location, postedAt: job.postedAt, source: job.source, url: job.url },
    description: job.description,
    descriptionTruncated: true,
    requiredTags: requiredTags.map(strip),
    niceToHaveTags: niceToHaveTags.map(strip),
    unclassifiedTags: unclassifiedTags.map(strip),
    minYears: job.minYears,
    // A long requirement list is not a to-do list. Without this an agent tends
    // to work through all of them in order; get_fit_gaps says which are already
    // evidenced and which are genuinely missing, which is the useful ordering.
    ...(requiredTags.length > 8
      ? {
        nextStep: 'get_fit_gaps',
        nextStepReason: `${requiredTags.length} required items is too many to address one by one. `
          + 'Call get_fit_gaps first: it splits them into what the fact bank already evidences and '
          + 'what is genuinely missing, so you can lead with the covered work instead of walking the list.',
      }
      : {}),
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
  const before = toolsInScope()
  if (!Array.isArray(edits) || edits.length === 0) {
    return err('no_edits', 'Pass at least one edit. Each needs targetBlockId, newText, rationale and sourceFactIds.')
  }
  if (edits.length > 8) {
    return err('too_many_edits', 'At most 8 edits per call. Split them across turns so the human can review.')
  }

  const queued: {
    editId: string
    targetBlockId: string
    combinesSources: number
    note?: string
  }[] = []
  const rejected: GuardFailure[] = []
  const accepted: PendingEdit[] = []

  for (const proposal of edits) {
    const failure = checkEdit(proposal, state.resume, state.facts)
    if (failure) { rejected.push(failure); continue }

    const block = state.resume.find((b) => b.id === proposal.targetBlockId)!
    const id = `e_${++editSeq}`
    const { combines } = sourceSpread(proposal.sourceFactIds, state.facts)
    accepted.push({
      ...proposal,
      id,
      jobId: state.openJobId,
      before: block.text,
      after: proposal.newText,
      status: 'pending',
      combinesSources: combines,
    })
    queued.push({
      editId: id,
      targetBlockId: proposal.targetBlockId,
      combinesSources: combines,
      ...(combines > 1 ? {
        note: `Combines ${combines} separate pieces of work. Allowed, but flagged for the `
          + 'user to verify — the guard checks that each ingredient is attested, not that '
          + 'the combination is something that actually happened.',
      } : {}),
    })
  }

  if (accepted.length > 0) set({ pendingEdits: [...state.pendingEdits, ...accepted] })

  const delta = scopeDelta(before)
  const parts = [`${queued.length} of ${edits.length} edit${edits.length === 1 ? '' : 's'} queued for review.`]
  if (rejected.length > 0) {
    parts.push(`${rejected.length} rejected: ${rejected.map((r) => r.offendingTokens.join('/') || r.reason).join('; ')}.`)
  }
  const combined = queued.filter((q) => (q.combinesSources ?? 0) > 1).length
  if (combined > 0) {
    parts.push(`${combined} flagged for the user as combining separate pieces of work.`)
  }
  if (delta.scopeNote) parts.push(delta.scopeNote)

  return { ok: true as const, summary: parts.join(' '), queued, rejected, ...delta }
}

export function withdrawEdit(editId: string) {
  const before = toolsInScope()
  const edit = state.pendingEdits.find((e) => e.id === editId)
  if (!edit) return err('edit_not_found', `No edit "${editId}". Call get_workspace_state to see pending edit ids.`)
  if (edit.status !== 'pending') {
    return err('edit_not_pending', `Edit "${editId}" is already ${edit.status} and cannot be withdrawn.`)
  }
  set({ pendingEdits: state.pendingEdits.filter((e) => e.id !== editId) })
  const delta = scopeDelta(before)
  return {
    ok: true as const,
    summary: `Withdrew ${editId}. ${delta.scopeNote}`.trim(),
    withdrawnId: editId,
    ...delta,
  }
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

// ---------------------------------------------------------------- phase 3

/**
 * Builds the application from the ACCEPTED resume state and fills the form on
 * screen. The precondition — a job open and zero pending edits — is the whole
 * human-in-the-loop story in one rule: nothing can be sent while a proposal the
 * human has not looked at is still outstanding.
 */
export function prepareApplication(coverNote: string, sourceFactIds: string[] = []) {
  const before = toolsInScope()
  const job = openJob()
  if (!job) return err('no_job_open', 'Call open_job first — an application is always for a specific posting.')

  const pending = pendingEdits().length
  if (pending > 0) {
    return err(
      'pending_edits',
      `${pending} edit${pending === 1 ? '' : 's'} still awaiting the human's review. `
      + 'They must accept or reject every proposal before an application can be prepared. '
      + 'Use withdraw_edit if you want to retract one.',
    )
  }

  const note = String(coverNote ?? '').slice(0, 900)
  if (note.trim().length === 0) {
    return err('empty_cover_note', 'Write a cover note grounded in the resume and the posting.')
  }

  // The note is sent alongside the resume, so it is held to the same standard.
  const noteFailure = checkCoverNote(note, state.facts, sourceFactIds)
  if (noteFailure) {
    return {
      ok: false as const,
      error: noteFailure.reason,
      offendingTokens: noteFailure.offendingTokens,
      hint: noteFailure.hint,
    }
  }

  const app: Application = {
    jobId: job.id,
    resumeSnapshot: state.resume.map((b) => ({ ...b })),
    coverNote: note,
    coverNoteFactIds: sourceFactIds,
    status: 'ready',
    submittedAt: null,
  }
  set({ applications: [...state.applications.filter((a) => a.jobId !== job.id), app] })

  const delta = scopeDelta(before)
  return {
    ok: true as const,
    ...delta,
    summary: `Application to ${job.company} is ready. ${app.resumeSnapshot.length} resume blocks and a `
      + `${note.length}-character cover note are filled in on screen. Nothing is sent until the human confirms. `
      + delta.scopeNote,
    preview: {
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      coverNote: note,
      resumeBlockIds: app.resumeSnapshot.map((b) => b.id),
    },
    missingRequiredFields: [],
  }
}


/**
 * The only consequential action. Opens a modal showing exactly what will be
 * sent and does not settle until the human clicks — or until the agent's turn
 * is aborted, in which case the modal closes and the promise REJECTS.
 */
export function submitApplication(signal?: AbortSignal): Promise<unknown> {
  const before = toolsInScope()
  const app = state.applications.find((a) => a.status === 'ready')
  if (!app) {
    return Promise.resolve(err('not_ready', 'No application is ready. Call prepare_application first.'))
  }
  if (submitResolver) {
    return Promise.resolve(err('already_confirming', 'A confirmation dialog is already open. Wait for the human.'))
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      submitResolver = null
      signal?.removeEventListener('abort', onAbort)
      set({ submitModalFor: null })
    }

    function onAbort() {
      cleanup()
      reject(new Error('aborted: the agent turn was cancelled, so the confirmation dialog was closed. Nothing was sent.'))
    }

    if (signal?.aborted) {
      reject(new Error('aborted before the dialog opened. Nothing was sent.'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    submitResolver = (confirmed: boolean) => {
      cleanup()
      if (!confirmed) {
        resolve(err('user_declined', 'The user cancelled. Ask what they want changed before trying again.'))
        return
      }
      const submittedAt = new Date().toISOString()
      set({
        applications: state.applications.map((a) =>
          a.jobId === app.jobId ? { ...a, status: 'submitted' as const, submittedAt } : a),
      })
      const job = JOBS.find((j) => j.id === app.jobId)
      const delta = scopeDelta(before)
      resolve({
        ok: true,
        summary: `Application to ${job?.company ?? app.jobId} submitted. ${delta.scopeNote}`.trim(),
        applicationId: app.jobId,
        submittedAt,
        ...delta,
      })
    }

    set({ submitModalFor: app.jobId })
  })
}

/** Human-only, from the modal. */
export function confirmSubmit() { submitResolver?.(true) }
export function cancelSubmit() { submitResolver?.(false) }

export function discardApplication(jobId: string) {
  set({ applications: state.applications.filter((a) => a.jobId !== jobId) })
}
