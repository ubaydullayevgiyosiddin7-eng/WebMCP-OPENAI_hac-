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
  /** How candidateYears was derived, so the number is inspectable rather than asserted. */
  yearsBasis: string
  candidateYears: number | null
}
