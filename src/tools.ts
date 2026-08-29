/**
 * WebMCP registration.
 *
 * Every `execute` delegates straight to a store action — the same function the
 * corresponding button calls. Nothing is computed here.
 *
 * Registration is feature-detected and degrades silently: with no
 * `document.modelContext` the app is still fully usable by hand, which is a
 * requirement in docs/TOOL_CONTRACT.md §6, and the status strip says so rather
 * than pretending a tool surface exists.
 *
 * Job-scoped tools live behind one AbortController. Closing a job aborts it,
 * which unregisters that scope in a single operation (§5).
 */
import {
  ALWAYS_TOOLS, EDIT_SCOPED_TOOLS, JOB_SCOPED_TOOLS, getApplications, getFitGaps, getJobDetails,
  getProfileFacts, getResume, getWorkspaceState, pendingEdits, proposeResumeEdits,
  requestProfileFact, searchJobs, selectJob, setWebmcpStatus, getState, subscribe,
  withdrawEdit,
} from './store'
import type { Application, EditProposal, FactKind, FactRequest, ResumeSection } from './types'

type ToolDescriptor = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  execute: (args: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => Promise<unknown>
}

declare global {
  interface Document {
    modelContext?: {
      registerTool: (
        tool: ToolDescriptor,
        options?: { signal?: AbortSignal },
      ) => Promise<unknown> | unknown
    }
  }
}

const READ_ONLY = { readOnlyHint: true }
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true }

const aborted = (ctx?: { signal?: AbortSignal }) =>
  ctx?.signal?.aborted
    ? { ok: false, error: 'aborted', hint: 'The turn was cancelled. Nothing was changed.' }
    : null

/** Wrap a synchronous store read so it honours the AbortSignal contract. */
function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  annotations: Record<string, unknown>,
  run: (args: Record<string, unknown>) => unknown,
): ToolDescriptor {
  return {
    name,
    description,
    inputSchema,
    annotations,
    execute: async (args, ctx) => aborted(ctx) ?? run(args ?? {}),
  }
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false }

const ALWAYS: ToolDescriptor[] = [
  tool(
    'get_workspace_state',
    'Orientation. Reports what is on screen right now: active filters, how many jobs match, which job is open, and how many tools are currently registered. Call this first in a new task. Reads only; changes nothing.',
    noArgs, READ_ONLY,
    () => getWorkspaceState(),
  ),
  tool(
    'get_profile_facts',
    "The candidate's fact bank. This is the ONLY legal source of resume claims — an experience that is not here has not been claimed, and must not be written into the resume. Reads only.",
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'role', 'achievement', 'education', 'language'] },
      },
      additionalProperties: false,
    },
    READ_ONLY,
    (a) => getProfileFacts(a.kind as FactKind | undefined),
  ),
  tool(
    'get_resume',
    'The current resume, block by block, each with its id and the fact ids it was built from. Use the block ids when proposing edits. Reads only.',
    {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['summary', 'experience', 'skills', 'education'] },
      },
      additionalProperties: false,
    },
    READ_ONLY,
    (a) => getResume(a.section as ResumeSection | undefined),
  ),
  tool(
    'get_applications',
    'The application tracker. Answers "what have I already applied to?". Reads only.',
    {
      type: 'object',
      properties: { status: { type: 'string', enum: ['draft', 'ready', 'submitted'] } },
      additionalProperties: false,
    },
    READ_ONLY,
    (a) => getApplications(a.status as Application['status'] | undefined),
  ),
  tool(
    'search_jobs',
    'Filter the job list. This CHANGES WHAT THE HUMAN SEES on screen — the sidebar controls move to match, which is intended. Replaces the whole filter set rather than merging, so pass the full intended filter state each time. Tag names resolve through the app vocabulary, so "tts" finds jobs tagged "speech".',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text over title, company, description and tags.' },
        remote: { type: 'boolean' },
        seniority: { type: 'string', enum: ['junior', 'mid', 'senior', 'lead'] },
        maxYears: {
          type: 'integer', minimum: 0, maximum: 20,
          description: 'Exclude postings demanding more than this many years.',
        },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
      },
      additionalProperties: false,
    },
    WRITES,
    (a) => searchJobs(a as Parameters<typeof searchJobs>[0]),
  ),
  tool(
    'open_job',
    'Select a job and open its detail pane. This CHANGES THE SCREEN and registers two further tools (get_job_details, get_fit_gaps) that are only meaningful while a job is open.',
    {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    WRITES,
    (a) => selectJob(String(a.jobId)),
  ),
  tool(
    'request_profile_fact',
    'Ask the human to add a fact to the bank. You CANNOT write to the fact bank yourself — this only opens a pre-filled panel that the human saves, edits or dismisses. Use it when get_fit_gaps reports something missing that you believe the candidate actually has. Returns immediately with awaiting_user; carry on and re-read get_profile_facts later.',
    {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'The fact as you understood it, written in the first person.' },
        kind: { type: 'string', enum: ['skill', 'role', 'achievement', 'education', 'language'] },
        why: { type: 'string', description: 'Why this posting makes it worth adding.' },
      },
      required: ['claim', 'kind', 'why'],
      additionalProperties: false,
    },
    WRITES,
    (a) => requestProfileFact(a as unknown as FactRequest),
  ),
]

const JOB_SCOPED: ToolDescriptor[] = [
  tool(
    'get_job_details',
    "The open posting: its stored description plus the app's parsed requirements, split into required / nice-to-have / unclassified. Every requirement carries the sentence it was read from, so you can quote evidence instead of asserting. The stored description is truncated — the full posting is at the job's url. Reads only.",
    noArgs, READ_ONLY,
    () => getJobDetails(),
  ),
  tool(
    'get_fit_gaps',
    'Deterministic comparison of the open posting against the fact bank. No model judgement is involved, which is what makes it checkable. `covered` names the fact ids that evidence each requirement; `missing` is your cue to ask the human via a profile-fact request rather than to invent anything. Reads only.',
    noArgs, READ_ONLY,
    () => getFitGaps(),
  ),
  tool(
    'propose_resume_edits',
    'Queue resume rewrites for HUMAN REVIEW. This never applies anything — each edit appears as a before/after diff the human accepts or rejects. Every edit must cite the fact ids that support its wording. Edits whose new text contains a technology, product name or number that no cited fact supports are REFUSED, and come back listing the offending tokens so you can correct them. Do not retry the same wording; either cite a fact that supports it, call request_profile_fact, or drop the claim.',
    {
      type: 'object',
      properties: {
        edits: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object',
            properties: {
              targetBlockId: { type: 'string' },
              newText: { type: 'string', maxLength: 400 },
              rationale: { type: 'string', maxLength: 200, description: 'Why this wording helps for THIS posting.' },
              sourceFactIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['targetBlockId', 'newText', 'rationale', 'sourceFactIds'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    WRITES,
    (a) => proposeResumeEdits((a.edits ?? []) as EditProposal[]),
  ),
]

const EDIT_SCOPED: ToolDescriptor[] = [
  tool(
    'withdraw_edit',
    'Retract a still-pending proposal — for example after the human rejects one and you want to offer different wording. Cannot touch an edit that has already been accepted.',
    {
      type: 'object',
      properties: { editId: { type: 'string' } },
      required: ['editId'],
      additionalProperties: false,
    },
    WRITES,
    (a) => withdrawEdit(String(a.editId)),
  ),
]

// ---------------------------------------------------------------- lifecycle

let started = false
let jobScope: AbortController | null = null
let jobScopeFor: string | null = null
let editScope: AbortController | null = null
let editScopeOn = false

async function register(t: ToolDescriptor, signal?: AbortSignal) {
  const mc = document.modelContext
  if (!mc?.registerTool) return
  try {
    const result = await mc.registerTool(t, signal ? { signal } : undefined)
    // Some implementations return an unregister handle instead of honouring the
    // signal. Support both so closing a job really does remove the tools.
    if (signal && result) {
      const un = typeof result === 'function'
        ? (result as () => void)
        : (result as { unregister?: () => void }).unregister
      if (typeof un === 'function') {
        signal.addEventListener('abort', () => { try { un() } catch { /* already gone */ } }, { once: true })
      }
    }
  } catch {
    // A failed registration must never break the page for the human.
  }
}

function syncJobScope() {
  const { openJobId } = getState()
  if (jobScopeFor === openJobId) return

  if (jobScope) {
    jobScope.abort()
    jobScope = null
  }
  jobScopeFor = openJobId

  if (openJobId) {
    jobScope = new AbortController()
    for (const t of JOB_SCOPED) void register(t, jobScope.signal)
  }
}

function syncEditScope() {
  const on = pendingEdits(getState()).length > 0
  if (on === editScopeOn) return
  editScopeOn = on

  if (!on) {
    editScope?.abort()
    editScope = null
    return
  }
  editScope = new AbortController()
  for (const t of EDIT_SCOPED) void register(t, editScope.signal)
}

function syncScopes() {
  syncJobScope()
  syncEditScope()
}

/** Safe to call unconditionally; does nothing in a browser without WebMCP. */
export function initTools() {
  if (started) return
  started = true

  if (typeof document === 'undefined' || typeof document.modelContext?.registerTool !== 'function') {
    setWebmcpStatus('unsupported')
    return
  }

  setWebmcpStatus('active')
  for (const t of ALWAYS) void register(t)
  subscribe(syncScopes)
  syncScopes()
}

export const TOOL_NAMES = {
  always: ALWAYS.map((t) => t.name),
  jobScoped: JOB_SCOPED.map((t) => t.name),
  editScoped: EDIT_SCOPED.map((t) => t.name),
}

// Keep the exported scope lists and the real descriptors from drifting apart —
// the status strip counts the store's lists, not these.
if (ALWAYS.map((t) => t.name).join() !== [...ALWAYS_TOOLS].join()
  || JOB_SCOPED.map((t) => t.name).join() !== [...JOB_SCOPED_TOOLS].join()
  || EDIT_SCOPED.map((t) => t.name).join() !== [...EDIT_SCOPED_TOOLS].join()) {
  console.warn('[tailor] registered tool scopes disagree with the store definition')
}
