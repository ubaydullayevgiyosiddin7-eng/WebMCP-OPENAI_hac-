/** Shapes from docs/TOOL_CONTRACT.md §2. The document is the source of truth. */

export type FactKind = 'skill' | 'role' | 'achievement' | 'education' | 'language'

export type Fact = {
  id: string
  kind: FactKind
  text: string
  tokens: string[]
}

export type JobTag = {
  tag: string
  /** ~140-char window quoted from the FULL posting, not the truncated description. */
  evidence: string
  /** true = hard requirement, false = nice-to-have, null = undetermined. Never guessed. */
  required: boolean | null
}

export type Seniority = 'junior' | 'mid' | 'senior' | 'lead'

export type Job = {
  id: string
  title: string
  company: string
  location: string
  remote: boolean
  seniority: Seniority
  minYears: number | null
  tags: JobTag[]
  tagNames: string[]
  description: string
  url: string
  postedAt: string | null
  source: string
}

export type ResumeSection = 'summary' | 'experience' | 'skills' | 'education'

export type ResumeBlock = {
  id: string
  section: ResumeSection
  text: string
  sourceFactIds: string[]
}

export type Application = {
  jobId: string
  resumeSnapshot: ResumeBlock[]
  coverNote: string
  /** Facts cited to ground the cover note; the guard checks it against these. */
  coverNoteFactIds: string[]
  status: 'draft' | 'ready' | 'submitted'
  submittedAt: string | null
}

export type Filters = {
  query: string
  remote: boolean | null
  seniority: Seniority | null
  maxYears: number | null
  tags: string[]
}

export const EMPTY_FILTERS: Filters = {
  query: '',
  remote: null,
  seniority: null,
  maxYears: null,
  tags: [],
}

export type CoveredEntry = { tag: string; factIds: string[] }

export type FitGaps = {
  covered: CoveredEntry[]
  missing: string[]
  yearsGap: number | null
  /** The experience fact's own words, so the number is judged rather than asserted. */
  yearsBasis: string
  candidateYears: number | null
  yearsFactId: string | null
  coverageRatio: number
  /** Plain-words fit, so a short years count cannot stand in for the whole picture. */
  verdict: string
}

// ---------------------------------------------------------------- phase 2

export type EditProposal = {
  targetBlockId: string
  newText: string
  rationale: string
  sourceFactIds: string[]
}

export type PendingEdit = EditProposal & {
  id: string
  jobId: string | null
  before: string
  after: string
  status: 'pending' | 'accepted' | 'rejected'
  /** Distinct pieces of work this sentence draws on. >1 is flagged, not blocked. */
  combinesSources: number
}

export type GuardReason =
  | 'unknown_block'
  | 'unknown_fact'
  | 'no_source_facts'
  | 'unsupported_claim'
  | 'no_change'

export type GuardFailure = {
  targetBlockId: string
  reason: GuardReason
  offendingTokens: string[]
  hint: string
}

/** A pre-filled request the human must accept before it becomes a fact. */
export type FactRequest = {
  claim: string
  kind: FactKind
  why: string
}
