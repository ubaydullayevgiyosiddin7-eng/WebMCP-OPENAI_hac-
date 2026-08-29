import { useEffect, useMemo, useSyncExternalStore } from 'react'
import './App.css'
import { groupTags, profileCoverage } from './lib/match'
import {
  ATTRIBUTION, FACTS, JOBS, PROFILE, closeJob, getState, openJob as getOpenJob,
  patchFilters, resetFilters, selectJob, subscribe, toolsInScope, visibleJobs,
} from './store'
import { initTools } from './tools'
import type { Job, JobTag, ResumeSection, Seniority } from './types'
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

  useEffect(() => { initTools() }, [])

  const matches = useMemo(() => visibleJobs(state), [state])
  const job = getOpenJob(state)
  const tools = toolsInScope(state)

  return (
    <div className="app">
      <StatusStrip toolCount={tools.length} tools={tools} webmcp={state.webmcp} />

      <main className="panes">
        <section className="pane pane--left" aria-label="Filters and job list">
          <Filters matchCount={matches.length} />
          <JobList jobs={matches} openJobId={state.openJobId} />
        </section>

        <section className="pane pane--center" aria-label="Job detail">
          {job ? <JobDetail job={job} /> : <EmptyDetail />}
        </section>

        <section className="pane pane--right" aria-label="Resume">
          <ResumePane />
        </section>
      </main>
    </div>
  )
}

function StatusStrip({ toolCount, tools, webmcp }: {
  toolCount: number
  tools: string[]
  webmcp: 'unsupported' | 'active'
}) {
  return (
    <header className="strip">
      <span className="strip__brand">tailor</span>
      <span className="strip__sep" />
      <span className="strip__who">{PROFILE.name} — {PROFILE.headline}</span>

      <span className="strip__spacer" />

      <span className={`strip__tools ${webmcp === 'active' ? 'is-live' : ''}`} title={tools.join('\n')}>
        <b>{toolCount}</b> tools registered
      </span>
      <span className={`badge ${webmcp === 'active' ? 'badge--ok' : 'badge--off'}`}>
        {webmcp === 'active' ? 'WebMCP active' : 'WebMCP not detected'}
      </span>
    </header>
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
