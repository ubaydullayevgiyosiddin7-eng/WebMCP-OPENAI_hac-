import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import './App.css'
import { conceptsIn } from './lib/guard'
import { groupTags, profileCoverage } from './lib/match'
import {
  ALWAYS_TOOLS, ATTRIBUTION, EDIT_SCOPED_TOOLS, FACTS, JOBS, JOB_SCOPED_TOOLS,
  PREPARE_SCOPED_TOOLS, PROFILE, SUBMIT_SCOPED_TOOLS, acceptEdit, cancelSubmit, closeJob,
  clearRefusals, confirmSubmit, discardApplication, dismissFactRequest,
  dismissRefusal, factById, getState,
  openJob as getOpenJob, hasCustomState, patchFilters, rejectEdit, resetDemoData,
  resetFilters, saveFactRequest, selectJob, subscribe, toolsInScope, visibleJobs,
} from './store'
import { initTools } from './tools'
import type { Application, FactRequest, Job, JobTag, PendingEdit, ResumeSection, Seniority } from './types'
import { EMPTY_FILTERS } from './types'

const SENIORITIES: Seniority[] = ['junior', 'mid', 'senior', 'lead']
const SECTION_ORDER: ResumeSection[] = ['summary', 'experience', 'skills', 'education']

/**
 * One-click tag filters: the most frequent tags on the board, plus every tag
 * this candidate can actually evidence. Frequency alone buries the ones that
 * matter most here — "computer vision", "opencv", "yolo" and "ocr" all sit
 * outside the top fourteen, so a vision engineer could not filter to his own
 * specialty from the sidebar.
 */
const FILTER_TAGS = (() => {
  const counts = new Map<string, number>()
  for (const j of JOBS) for (const t of j.tagNames) counts.set(t, (counts.get(t) ?? 0) + 1)

  const covered = new Set(profileCoverage(FACTS).keys())
  const keep = new Set<string>()
  const byFreq = [...counts.entries()].sort((a, b) => b[1] - a[1])

  for (const [tag] of byFreq.slice(0, 10)) keep.add(tag)
  for (const [tag] of byFreq) if (covered.has(tag)) keep.add(tag)

  return byFreq.filter(([tag]) => keep.has(tag))
})()

export default function App() {
  const state = useSyncExternalStore(subscribe, getState)
  const [listOpen, setListOpen] = useState(true)

  useEffect(() => { initTools() }, [])

  // Opening a job is a decision to work on it; at narrow widths the list has
  // done its job and the posting needs the room. Compared during render rather
  // than synced in an effect — this is a reaction to a state change, not to an
  // external system.
  const [lastJobId, setLastJobId] = useState(state.openJobId)
  if (lastJobId !== state.openJobId) {
    setLastJobId(state.openJobId)
    if (state.openJobId && window.matchMedia('(max-width: 1000px)').matches) setListOpen(false)
  }

  const matches = useMemo(() => visibleJobs(state), [state])
  const job = getOpenJob(state)
  const tools = toolsInScope(state)

  const pending = state.pendingEdits.filter((e) => e.status === 'pending')
  // At recording width the panes cannot sit side by side, so whatever the human
  // must act on is pulled above the posting. Nothing that needs a decision may
  // require scrolling to find.
  const needsAttention = pending.length > 0 || state.refusals.length > 0 || Boolean(state.factRequest)

  return (
    <div className="app">
      <StatusStrip
        webmcp={state.webmcp}
        matchCount={matches.length}
        listOpen={listOpen}
        onToggleList={() => setListOpen((v) => !v)}
      />
      <ToolRail names={tools} />

      <main className={`panes ${needsAttention ? 'panes--review-first' : ''} ${listOpen ? 'is-list-open' : ''}`}>
        <section className="pane pane--left" aria-label="Filters and job list">
          <Filters matchCount={matches.length} />
          <JobList jobs={matches} openJobId={state.openJobId} />
        </section>

        <section className="pane pane--center" aria-label="Job detail">
          {job ? <JobDetail job={job} /> : <EmptyDetail />}
        </section>

        <section className="pane pane--right" aria-label="Resume, review queue and applications">
          <FactRequestPanel />
          <RefusalList refusals={state.refusals} />
          <ReviewQueue edits={pending} />
          <PreparedApplication apps={state.applications} />
          <ResumePane />
          <Tracker apps={state.applications} />
        </section>
      </main>

      {state.submitModalFor && <SubmitModal jobId={state.submitModalFor} apps={state.applications} />}
    </div>
  )
}

function StatusStrip({ webmcp, matchCount, listOpen, onToggleList }: {
  webmcp: 'unsupported' | 'active'
  matchCount: number
  listOpen: boolean
  onToggleList: () => void
}) {
  return (
    <header className="strip">
      <button
        className={`strip__jobs ${listOpen ? 'is-on' : ''}`}
        onClick={onToggleList}
        aria-expanded={listOpen}
      >
        jobs <b>{matchCount}</b>
      </button>
      <span className="strip__brand">tailor</span>
      <span className="strip__sep" />
      <span className="strip__who">{PROFILE.name} — {PROFILE.headline}</span>

      <span className="strip__spacer" />

      <span className={`badge ${webmcp === 'active' ? 'badge--ok' : 'badge--off'}`}>
        {webmcp === 'active' ? 'WebMCP active' : 'WebMCP not detected'}
      </span>
      <ResetControl />
    </header>
  )
}

function ResetControl() {
  const state = useSyncExternalStore(subscribe, getState)
  const dirty = hasCustomState(state)
  return (
    <button
      className="link strip__reset"
      title="Clear accepted edits, added facts and applications, and restore the shipped demo data."
      onClick={() => {
        if (!dirty || window.confirm('Reset the demo? Accepted edits, added facts and applications will be discarded.')) {
          resetDemoData()
        }
      }}
    >
      reset demo data{dirty ? ' •' : ''}
    </button>
  )
}

function Filters({ matchCount }: { matchCount: number }) {
  const { filters } = useSyncExternalStore(subscribe, getState)
  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS)

  return (
    <div className="filters">
      <div className="filters__row">
        <input
          className="input"
          type="search"
          placeholder="Search title, company, description…"
          value={filters.query}
          onChange={(e) => patchFilters({ query: e.target.value })}
        />
      </div>

      <div className="filters__row">
        <div className="seg" role="group" aria-label="Location">
          <button className={filters.remote === null ? 'is-on' : ''} onClick={() => patchFilters({ remote: null })}>Any</button>
          <button className={filters.remote === true ? 'is-on' : ''} onClick={() => patchFilters({ remote: true })}>Remote</button>
          <button className={filters.remote === false ? 'is-on' : ''} onClick={() => patchFilters({ remote: false })}>On-site</button>
        </div>

        <select
          className="input input--sm"
          value={filters.seniority ?? ''}
          onChange={(e) => patchFilters({ seniority: (e.target.value || null) as Seniority | null })}
          aria-label="Seniority"
        >
          <option value="">Any level</option>
          {SENIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <select
          className="input input--sm"
          value={filters.maxYears ?? ''}
          onChange={(e) => patchFilters({ maxYears: e.target.value === '' ? null : Number(e.target.value) })}
          aria-label="Maximum years required"
        >
          <option value="">Any years</option>
          {[0, 1, 2, 3, 4, 5, 7, 10].map((y) => <option key={y} value={y}>≤ {y}y</option>)}
        </select>
      </div>

      <div className="filters__tags">
        {FILTER_TAGS.map(([tag, n]) => {
          const on = filters.tags.includes(tag)
          return (
            <button
              key={tag}
              className={`chip chip--btn ${on ? 'is-on' : ''}`}
              onClick={() => patchFilters({
                tags: on ? filters.tags.filter((t) => t !== tag) : [...filters.tags, tag],
              })}
            >
              {tag}<span className="chip__n">{n}</span>
            </button>
          )
        })}
      </div>

      <div className="filters__foot">
        <span className="count"><b>{matchCount}</b> of {JOBS.length}</span>
        {dirty && <button className="link" onClick={() => resetFilters()}>clear filters</button>}
      </div>
    </div>
  )
}

function JobList({ jobs, openJobId }: { jobs: Job[]; openJobId: string | null }) {
  if (jobs.length === 0) {
    return <div className="joblist joblist--empty">No jobs match these filters.</div>
  }
  return (
    <ol className="joblist">
      {jobs.map((job) => (
        <li key={job.id}>
          <button
            className={`jobrow ${job.id === openJobId ? 'is-open' : ''}`}
            onClick={() => selectJob(job.id)}
            aria-current={job.id === openJobId}
          >
            <span className="jobrow__title">{job.title}</span>
            <span className="jobrow__company">{job.company}</span>
            <span className="jobrow__meta">
              <span className="tick">{job.seniority}</span>
              <span className="tick">{job.minYears === null ? '—' : `${job.minYears}y`}</span>
              <span className="tick">{job.remote ? 'remote' : 'on-site'}</span>
              <span className="tick tick--dim">{job.source}</span>
            </span>
            <span className="jobrow__tags">
              {job.tagNames.slice(0, 5).map((t) => <span key={t} className="chip">{t}</span>)}
              {job.tagNames.length > 5 && <span className="chip chip--more">+{job.tagNames.length - 5}</span>}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

function EmptyDetail() {
  return (
    <div className="empty">
      <p>No job open.</p>
      <p className="empty__hint">
        Select a posting on the left. Two extra tools — <code>get_job_details</code> and{' '}
        <code>get_fit_gaps</code> — register while a job is open, and the counter above will move.
      </p>
    </div>
  )
}

function JobDetail({ job }: { job: Job }) {
  const { requiredTags, niceToHaveTags, unclassifiedTags } = groupTags(job)
  return (
    <article className="detail">
      <header className="detail__head">
        <div>
          <h1 className="detail__title">{job.title}</h1>
          <div className="detail__company">{job.company} · {job.location}</div>
        </div>
        <button className="link" onClick={() => closeJob()}>close</button>
      </header>

      <div className="detail__meta">
        <span className="tick">{job.seniority}</span>
        <span className="tick">{job.minYears === null ? 'years unstated' : `${job.minYears}y minimum`}</span>
        <span className="tick">{job.remote ? 'remote' : 'on-site'}</span>
        {job.postedAt && <span className="tick tick--dim">posted {job.postedAt}</span>}
        <span className="tick tick--dim">via {job.source}</span>
        <a className="link" href={job.url} target="_blank" rel="noreferrer noopener">original posting ↗</a>
      </div>

      <section className="reqs">
        <ReqGroup kind="required" label="Required" tags={requiredTags} />
        <ReqGroup kind="nice" label="Nice to have" tags={niceToHaveTags} />
        <ReqGroup kind="unclassified" label="Unclassified" tags={unclassifiedTags}
          note="The posting's structure did not make the strength of these clear. They are not promoted to required." />
      </section>

      <section className="desc">
        <h2 className="h2">Description</h2>
        <p className="desc__body">{job.description}</p>
        <p className="desc__note">
          Truncated to 1400 characters. The full posting stays at the{' '}
          <a className="link" href={job.url} target="_blank" rel="noreferrer noopener">original source</a>.
        </p>
      </section>
    </article>
  )
}

function ReqGroup({ kind, label, tags, note }: {
  kind: 'required' | 'nice' | 'unclassified'
  label: string
  tags: JobTag[]
  note?: string
}) {
  if (tags.length === 0) return null
  return (
    <div className={`reqgroup reqgroup--${kind}`}>
      <h2 className="h2">
        {label} <span className="h2__n">{tags.length}</span>
      </h2>
      {note && <p className="reqgroup__note">{note}</p>}
      <ul className="reqlist">
        {tags.map((t) => (
          <li key={t.tag}>
            <details className="req">
              <summary className="req__summary" title={t.evidence}>
                <span className="req__tag">{t.tag}</span>
                <span className="req__cue">evidence</span>
              </summary>
              <blockquote className="req__evidence">{t.evidence}</blockquote>
            </details>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ResumePane() {
  const { resume } = useSyncExternalStore(subscribe, getState)
  const factText = useMemo(() => new Map(FACTS.map((f) => [f.id, f.text])), [])

  return (
    <div className="resume">
      <header className="resume__head">
        <h2 className="h2">Resume</h2>
        <span className="resume__state">baseline · untailored</span>
      </header>

      {SECTION_ORDER.map((section) => {
        const blocks = resume.filter((b) => b.section === section)
        if (blocks.length === 0) return null
        return (
          <section key={section} className="rsec">
            <h3 className="rsec__h">{section}</h3>
            {blocks.map((b) => (
              <article key={b.id} className="block">
                <p className="block__text">{b.text}</p>
                <div className="block__foot">
                  <code className="block__id">{b.id}</code>
                  <span className="block__facts">
                    {b.sourceFactIds.map((id) => (
                      <span key={id} className="factref" title={factText.get(id) ?? id}>{id}</span>
                    ))}
                  </span>
                </div>
              </article>
            ))}
          </section>
        )
      })}

      <footer className="resume__foot">{ATTRIBUTION}</footer>
    </div>
  )
}


/** Common prefix/suffix trimmed so the eye lands on what actually changed. */
function diffParts(before: string, after: string) {
  const a = before.split(/(\s+)/)
  const b = after.split(/(\s+)/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  return {
    prefix: a.slice(0, start).join(''),
    removed: a.slice(start, endA).join(''),
    added: b.slice(start, endB).join(''),
    suffix: a.slice(endA).join(''),
  }
}

function RefusalList({ refusals }: { refusals: { id: string; offendingTokens: string[]; targetBlockId: string; reason: string }[] }) {
  if (refusals.length === 0) return null
  return (
    <div className="refusals">
      <header className="queue__head">
        <h2 className="h2">Guard held {refusals.length === 1 ? 'a claim' : `${refusals.length} claims`} back</h2>
        {refusals.length > 1 && <button className="link" onClick={() => clearRefusals()}>dismiss all</button>}
      </header>
      {refusals.map((r) => <Refusal key={r.id} r={r} />)}
    </div>
  )
}

function Refusal({ r }: { r: { id: string; offendingTokens: string[]; targetBlockId: string; reason: string } }) {
  const plural = r.offendingTokens.length !== 1
  return (
    <article className="refusal">
      <div className="refusal__label">refused</div>

      <div className="refusal__tokens">
        {r.offendingTokens.map((t) => <span key={t} className="refusal__token">{t}</span>)}
      </div>

      <p className="refusal__why">
        {r.reason === 'unsupported_claim'
          ? `Nothing you have claimed supports ${plural ? 'these terms' : 'this term'}. The edit was not queued.`
          : `The edit was not queued (${r.reason.replace(/_/g, ' ')}).`}
      </p>

      <div className="refusal__foot">
        <code className="block__id">{r.targetBlockId}</code>
        <button className="link" onClick={() => dismissRefusal(r.id)}>dismiss</button>
      </div>
    </article>
  )
}

function ReviewQueue({ edits }: { edits: PendingEdit[] }) {
  if (edits.length === 0) return null
  return (
    <div className="queue">
      <header className="queue__head">
        <h2 className="h2">Proposed edits <span className="h2__n">{edits.length}</span></h2>
        <span className="queue__note">accept or reject — the agent cannot apply these</span>
      </header>
      {edits.map((e) => <EditCard key={e.id} edit={e} />)}
    </div>
  )
}

function EditCard({ edit }: { edit: PendingEdit }) {
  const d = diffParts(edit.before, edit.after)
  const combined = edit.combinesSources > 1
  return (
    <article className={`edit ${combined ? 'edit--combined' : ''}`}>
      <div className="edit__top">
        <code className="edit__id">{edit.id}</code>
        <code className="edit__target">{edit.targetBlockId}</code>
      </div>

      <p className="edit__rationale">{edit.rationale}</p>

      <div className="edit__diff">
        <span className="d-ctx">{d.prefix}</span>
        {d.removed && <del className="d-del">{d.removed}</del>}
        {d.added && <ins className="d-add">{d.added}</ins>}
        <span className="d-ctx">{d.suffix}</span>
      </div>

      {/* Provenance is the load-bearing element: the claim rests on facts the
          user wrote, quoted here rather than referenced by id. */}
      <div className="grounds">
        <div className="grounds__label">grounded in {edit.sourceFactIds.length} of your facts</div>
        {edit.sourceFactIds.map((id) => {
          const f = factById(id)
          return (
            <p key={id} className="grounds__item">
              <code className="grounds__id">{id}</code>
              <span className="grounds__text">{f ? f.text : 'unknown fact'}</span>
            </p>
          )
        })}
      </div>

      {combined && (
        <p className="edit__combines">
          <b>Needs your judgement.</b> This sentence draws on {edit.combinesSources} separate
          pieces of work. Each term is backed by a fact above, but nothing checks that the
          combination describes something that actually happened.
        </p>
      )}

      <div className="edit__actions">
        <button className="btn btn--accept" onClick={() => acceptEdit(edit.id)}>Accept</button>
        <button className="btn" onClick={() => rejectEdit(edit.id)}>Reject</button>
      </div>
    </article>
  )
}

function FactRequestPanel() {
  const { factRequest } = useSyncExternalStore(subscribe, getState)
  if (!factRequest) return null
  // Keyed so a new request remounts with fresh state — no effect needed.
  return <FactRequestForm key={factRequest.claim} req={factRequest} />
}

function FactRequestForm({ req }: { req: FactRequest }) {
  const [claim, setClaim] = useState(req.claim)
  const [tokens, setTokens] = useState(() => [...conceptsIn(req.claim)].join(', '))

  return (
    <div className={`factreq ${req.gapTags?.length ? 'factreq--leading' : ''}`}>
      <h2 className="h2">The agent is asking you to confirm a fact</h2>
      <p className="factreq__why">{req.why}</p>

      {req.gapTags?.length > 0 && (
        <p className="factreq__leading">
          <b>This question came from the job posting, not from your profile.</b>{' '}
          Nothing you have recorded mentions {req.gapTags.join(' or ')}, and this posting requires
          {req.gapTags.length === 1 ? ' it' : ' them'}. Add
          {req.gapTags.length === 1 ? ' it' : ' them'} only if you have genuinely done this work.
          A posting asking for something is not a reason to claim it.
        </p>
      )}

      <label className="factreq__label" htmlFor="fr-claim">Claim — edit it into your own words</label>
      <textarea
        id="fr-claim"
        className="input factreq__claim"
        rows={3}
        value={claim}
        onChange={(e) => setClaim(e.target.value)}
      />

      <label className="factreq__label" htmlFor="fr-tokens">Match tokens</label>
      <input
        id="fr-tokens"
        className="input"
        value={tokens}
        onChange={(e) => setTokens(e.target.value)}
      />

      <div className="edit__actions">
        <button
          className="btn btn--accept"
          disabled={claim.trim().length === 0}
          onClick={() => saveFactRequest(
            claim.trim(),
            req.kind,
            tokens.split(',').map((t) => t.trim()).filter(Boolean),
          )}
        >
          {req.gapTags?.length ? 'Yes, I have done this' : 'Add to fact bank'}
        </button>
        <button className="btn" onClick={() => dismissFactRequest()}>Dismiss</button>
      </div>
    </div>
  )
}


function PreparedApplication({ apps }: { apps: Application[] }) {
  const ready = apps.find((a) => a.status === 'ready')
  if (!ready) return null
  const job = JOBS.find((j) => j.id === ready.jobId)
  return (
    <div className="appform">
      <header className="queue__head">
        <h2 className="h2">Application — ready to send</h2>
        <span className="queue__note">nothing is sent until you confirm</span>
      </header>

      <dl className="appform__fields">
        <dt>Role</dt><dd>{job?.title ?? ready.jobId}</dd>
        <dt>Company</dt><dd>{job?.company ?? '—'}</dd>
        <dt>Resume</dt><dd>{ready.resumeSnapshot.length} blocks, as currently accepted</dd>
        <dt>Cover note</dt><dd className="appform__note">{ready.coverNote}</dd>
      </dl>

      <div className="edit__actions">
        <button className="btn" onClick={() => discardApplication(ready.jobId)}>Discard</button>
      </div>
    </div>
  )
}

function Tracker({ apps }: { apps: Application[] }) {
  if (apps.length === 0) return null
  return (
    <div className="tracker">
      <h2 className="h2">Applications <span className="h2__n">{apps.length}</span></h2>
      <ul className="tracker__list">
        {apps.map((a) => {
          const job = JOBS.find((j) => j.id === a.jobId)
          return (
            <li key={a.jobId} className="tracker__row">
              <span className={`tracker__status tracker__status--${a.status}`}>{a.status}</span>
              <span className="tracker__job">
                {job?.title ?? a.jobId}
                <span className="tracker__co">{job?.company ?? ''}</span>
              </span>
              {a.submittedAt && <span className="tick tick--dim">{a.submittedAt.slice(0, 10)}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function SubmitModal({ jobId, apps }: { jobId: string; apps: Application[] }) {
  const app = apps.find((a) => a.jobId === jobId)
  const job = JOBS.find((j) => j.id === jobId)
  if (!app) return null

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="submit-h">
      <div className="modal__box">
        <h2 className="h2" id="submit-h">Send this application?</h2>
        <p className="modal__lede">
          This is the only action that leaves the page. Everything below is exactly what will be sent.
        </p>

        <dl className="appform__fields">
          <dt>Role</dt><dd>{job?.title ?? jobId}</dd>
          <dt>Company</dt><dd>{job?.company ?? '—'}</dd>
          <dt>Cover note</dt><dd className="appform__note">{app.coverNote}</dd>
        </dl>

        <div className="modal__resume">
          {app.resumeSnapshot.map((b) => (
            <p key={b.id} className="modal__block">
              <code className="block__id">{b.id}</code> {b.text}
            </p>
          ))}
        </div>

        <div className="edit__actions modal__actions">
          <button className="btn btn--accept" onClick={() => confirmSubmit()}>Submit</button>
          <button className="btn" onClick={() => cancelSubmit()}>Cancel</button>
        </div>
      </div>
    </div>
  )
}


const TOOL_GROUPS: { label: string; members: readonly string[] }[] = [
  { label: 'always', members: ALWAYS_TOOLS },
  { label: 'job', members: JOB_SCOPED_TOOLS },
  { label: 'edit', members: EDIT_SCOPED_TOOLS },
  { label: 'application', members: [...PREPARE_SCOPED_TOOLS, ...SUBMIT_SCOPED_TOOLS] },
]

/**
 * The registered tool surface, named and grouped by the scope that governs it.
 *
 * A count alone hides the interesting part: when an edit is queued,
 * prepare_application leaves as withdraw_edit arrives, so the number is
 * unchanged while the surface is meaningfully different. Names make that
 * legible. Departing tools linger briefly greyed-out so a removal is as
 * perceptible as an arrival.
 */
function ToolRail({ names }: { names: string[] }) {
  const key = names.join()
  const [seen, setSeen] = useState({ key, names, leaving: [] as string[] })

  if (seen.key !== key) {
    setSeen({ key, names, leaving: seen.names.filter((n) => !names.includes(n)) })
  }

  useEffect(() => {
    if (seen.leaving.length === 0) return
    const t = setTimeout(() => setSeen((s) => (s.leaving.length ? { ...s, leaving: [] } : s)), 900)
    return () => clearTimeout(t)
  }, [seen.leaving])

  return (
    <div className="rail" aria-label="Tools registered for the agent">
      <span className="rail__count"><b>{names.length}</b> tools</span>
      {TOOL_GROUPS.map((g) => {
        const live = g.members.filter((m) => names.includes(m))
        const going = g.members.filter((m) => seen.leaving.includes(m))
        if (live.length === 0 && going.length === 0) return null
        return (
          <span className="rail__group" key={g.label}>
            <span className="rail__label">{g.label}</span>
            {live.map((n) => <span key={n} className="tchip">{n}</span>)}
            {going.map((n) => <span key={n} className="tchip is-out">{n}</span>)}
          </span>
        )
      })}
    </div>
  )
}
