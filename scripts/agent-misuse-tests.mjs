/**
 * Agent-shaped misuse tests.
 *
 * The guard suite checks what the guard decides. This one checks what happens
 * when an agent does something *reasonable but wrong* — acts on the wrong
 * object, calls things out of order, passes a string where an array belongs,
 * or believes a tool does something it does not.
 *
 *   npm run build && npx vite preview --port 4173
 *   node scripts/agent-misuse-tests.mjs [http://localhost:4173/]
 *
 * Every call must come back with { summary } and never throw, because a
 * rejected promise gives a real agent nothing to correct.
 */
import { chromium } from 'file:///C:/Users/Flex/AppData/Local/npm-cache/_npx/db89d7302a373f10/node_modules/playwright/index.mjs'

const URL = process.argv[2] ?? 'http://localhost:4173/'
const JOB_A = 'j_us-lbm_us-lbm-ai-engineer'
const JOB_B = 'j_addepto_data-scientist-ai-engineer'

const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

await page.addInitScript(() => {
  const reg = new Map()
  window.__mcp = {
    reg,
    names: () => [...reg.keys()].sort(),
    // Keep every descriptor ever registered, so we can call a tool that has
    // since gone out of scope — exactly what a stale agent reference does.
    seen: new Map(),
    async call(name, args, opts) {
      const t = reg.get(name) ?? window.__mcp.seen.get(name)
      if (!t) return { __missing: true }
      return t.execute(args ?? {}, opts ?? {})
    },
  }
  document.modelContext = {
    registerTool(tool, opts) {
      reg.set(tool.name, tool)
      window.__mcp.seen.set(tool.name, tool)
      opts?.signal?.addEventListener('abort', () => reg.delete(tool.name), { once: true })
      return { unregister: () => reg.delete(tool.name) }
    },
  }
})

await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })

const call = (name, args) => page.evaluate(
  ([n, a]) => window.__mcp.call(n, a).then((r) => r, (e) => ({ __threw: String(e && e.message || e) })),
  [name, args],
)
const facts = () => page.evaluate(() => window.__mcp.call('get_profile_facts').then((r) => r.facts))
const names = () => page.evaluate(() => window.__mcp.names())

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}`)
  if (detail) console.log(`         ${detail}`)
}

/** Every refusal must be structured, self-describing, and non-throwing. */
function wellFormedRefusal(r) {
  if (!r || r.__threw) return `THREW: ${r?.__threw}`
  if (r.__missing) return 'tool was not registered (acceptable, but not a refusal)'
  if (r.ok !== false) return 'did not refuse'
  if (typeof r.summary !== 'string' || !r.summary) return 'refusal has no summary'
  if (typeof r.hint !== 'string' || !r.hint) return 'refusal has no hint'
  return null
}

// ===================================================================
console.log('\n=== A. THE FACT BANK IS UNWRITABLE (proved, not assumed) ===')

const before = await facts()
const factsJson = JSON.stringify(before)

// Fire every registered tool with arguments designed to write a fact.
const hostile = {
  get_workspace_state: {},
  get_profile_facts: { kind: 'skill' },
  get_resume: {},
  get_applications: {},
  search_jobs: { query: 'kubernetes' },
  open_job: { jobId: JOB_A },
  request_profile_fact: {
    claim: 'I have production Kubernetes and TensorFlow experience.',
    kind: 'skill',
    why: 'The posting requires them.',
  },
  get_job_details: {},
  get_fit_gaps: {},
  propose_resume_edits: {
    edits: [{
      targetBlockId: 'b_skills',
      newText: 'Backend: FastAPI, Docker, Kubernetes, TensorFlow.',
      rationale: 'x',
      sourceFactIds: ['f_backend'],
    }],
  },
  withdraw_edit: { editId: 'e_1' },
  prepare_application: { coverNote: 'Hello.', sourceFactIds: [] },
}

for (const [tool, args] of Object.entries(hostile)) {
  await call(tool, args)
}
const after = await facts()
check(
  'no registered tool changed the fact bank',
  JSON.stringify(after) === factsJson,
  `${before.length} facts before, ${after.length} after`,
)

// request_profile_fact specifically: it must open a question, not record one.
await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })
const rpf = await call('request_profile_fact', {
  claim: 'I have production Kubernetes experience.',
  kind: 'skill',
  why: 'The posting requires it.',
})
const afterAsk = await facts()
check(
  'request_profile_fact does not write a fact',
  afterAsk.length === before.length,
  `status=${rpf.status}, facts still ${afterAsk.length}`,
)
check(
  'request_profile_fact says plainly that nothing was added',
  /nothing was added/i.test(rpf.summary ?? ''),
  rpf.summary?.slice(0, 100),
)
const panelUp = await page.locator('.factreq').isVisible()
check('it opens a panel for the human instead', panelUp, `panel visible: ${panelUp}`)

// The fact only exists once a human clicks. Prove the human path still works.
await page.locator('.factreq .btn', { hasText: 'Add to fact bank' }).click()
await page.waitForTimeout(200)
const afterHuman = await facts()
check(
  'the human — and only the human — can add it',
  afterHuman.length === before.length + 1,
  `${before.length} -> ${afterHuman.length} after a human click`,
)

// ===================================================================
console.log('\n=== A2. GAP-DRIVEN QUESTIONS ARE LEADING QUESTIONS ===')
await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })
await call('open_job', { jobId: JOB_A })

let g = await call('request_profile_fact', {
  claim: 'I have production Kubernetes experience.',
  kind: 'skill',
  why: 'The posting requires Kubernetes.',
})
check('asking about a required-but-unsupported skill is flagged leading',
  g.leadingQuestion === true && g.gapTags?.includes('kubernetes'),
  `gapTags: ${JSON.stringify(g.gapTags)}`)
check('the warning leads the summary, so an agent reading only summary sees it',
  /^This is a leading question/.test(g.summary ?? ''), (g.summary ?? '').slice(0, 95))
check('the agent is told to relay it, not merely informed',
  /say this to them/i.test(g.warning ?? ''), (g.warning ?? '').slice(0, 80))

const onScreen = await page.locator('.factreq__leading').isVisible()
check('the human is warned on screen regardless of what the agent relays',
  onScreen, `notice visible: ${onScreen}`)
const btn = await page.locator('.factreq .btn--accept').innerText()
check('the confirm button asks for a claim, not an action',
  /have done this/i.test(btn), `button reads: "${btn}"`)

// A question about something the posting does NOT require is ordinary.
await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })
await call('open_job', { jobId: JOB_A })
g = await call('request_profile_fact', {
  claim: 'I presented this work at a national conference.',
  kind: 'achievement',
  why: 'Worth recording.',
})
check('an ordinary question is not flagged',
  !g.leadingQuestion && (g.gapTags ?? []).length === 0,
  (g.summary ?? '').slice(0, 80))
const plain = await page.locator('.factreq__leading').count()
check('and shows no warning on screen', plain === 0, `notices: ${plain}`)

// The contract's demo beat must still work: the user says it, the agent relays.
g = await call('request_profile_fact', {
  claim: 'I have production Kubernetes experience.',
  kind: 'skill',
  why: 'The user said so.',
})
check('a flagged question is still ALLOWED, not refused (demo beat 6 survives)',
  g.ok === true && g.status === 'awaiting_user',
  `status: ${g.status}`)

// ===================================================================
console.log('\n=== B. WRONG OBJECT / WRONG ORDER ===')
await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })

let r = await call('open_job', { jobId: 'j_does_not_exist' })
check('open_job with an unknown id refuses cleanly',
  wellFormedRefusal(r) === null, wellFormedRefusal(r) ?? r.summary)

r = await call('propose_resume_edits', {
  edits: [{ targetBlockId: 'b_summary', newText: 'Anything at all here.', rationale: 'x', sourceFactIds: ['r_customs'] }],
})
check('propose_resume_edits with no job open refuses',
  r.__missing || wellFormedRefusal(r) === null,
  r.__missing ? 'not registered (correct)' : (wellFormedRefusal(r) ?? r.summary))

await call('open_job', { jobId: JOB_A })
r = await call('open_job', { jobId: JOB_A })
check('re-opening the same job says nothing changed',
  r.ok === true && /already open/i.test(r.summary), r.summary)

r = await call('open_job', { jobId: JOB_B })
check('opening another job reports the switch',
  r.ok === true && r.switchedFrom === JOB_A && /closed/i.test(r.summary),
  r.summary?.slice(0, 120))

// Edits on job B, then switch to job A: they must be reported as stranded.
await call('propose_resume_edits', {
  edits: [{ targetBlockId: 'b_summary', newText: 'Computer vision engineer working with YOLO and OpenCV at the State Customs Committee.', rationale: 'x', sourceFactIds: ['r_customs', 'f_yolo', 'f_opencv'] }],
})
r = await call('open_job', { jobId: JOB_A })
check('switching jobs warns about edits left pending on the old one',
  (r.strandedEditIds ?? []).length === 1 && /still await review/i.test(r.summary),
  r.summary?.slice(0, 150))

r = await call('prepare_application', { coverNote: 'Hello.', sourceFactIds: [] })
check('prepare_application refuses while those edits pend',
  wellFormedRefusal(r) === null && r.error === 'pending_edits',
  wellFormedRefusal(r) ?? r.summary?.slice(0, 90))

r = await call('withdraw_edit', { editId: 'e_nope' })
check('withdraw_edit with an unknown id refuses cleanly',
  wellFormedRefusal(r) === null, wellFormedRefusal(r) ?? r.summary)

r = await call('propose_resume_edits', {
  edits: [{ targetBlockId: 'b_summary', newText: 'Some new summary text here.', rationale: 'x', sourceFactIds: ['f_not_a_real_fact'] }],
})
check('citing a non-existent factId refuses, not throws',
  r.ok === true && r.rejected?.[0]?.reason === 'unknown_fact',
  r.rejected?.[0]?.hint?.slice(0, 80))

// ===================================================================
console.log('\n=== C. MALFORMED ARGUMENTS ===')
await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })
await call('open_job', { jobId: JOB_A })

const malformed = [
  ['search_jobs', { tags: 'computer vision' }, 'tags as a bare string'],
  ['search_jobs', { maxYears: 'three' }, 'maxYears as a word'],
  ['open_job', {}, 'missing jobId'],
  ['propose_resume_edits', { edits: 'not an array' }, 'edits as a string'],
  ['propose_resume_edits', { edits: [{ targetBlockId: 'b_summary', newText: 'x y z', rationale: 'r', sourceFactIds: 'r_customs' }] }, 'sourceFactIds as a string'],
  ['propose_resume_edits', { edits: [{}] }, 'empty edit object'],
  ['prepare_application', { coverNote: 'Hi.', sourceFactIds: 'f_opencv' }, 'sourceFactIds as a string'],
  ['prepare_application', {}, 'missing coverNote'],
  ['withdraw_edit', {}, 'missing editId'],
  ['get_profile_facts', { kind: 'nonsense' }, 'invalid enum'],
]

/** Wrong beliefs an agent could form from a response that "succeeded". */
const beliefs = [
  {
    name: 'maxYears as a word does not silently return everything',
    run: () => call('search_jobs', { maxYears: 'three' }),
    ok: (r) => (r.ignoredParameters ?? []).length > 0 && /IGNORED/.test(r.summary),
  },
  {
    name: 'seniority garbage is reported, not dropped',
    run: () => call('search_jobs', { seniority: 'principal' }),
    ok: (r) => (r.ignoredParameters ?? []).some((x) => x.startsWith('seniority')),
  },
  {
    name: 'an unknown fact kind does not read as an empty bank',
    run: () => call('get_profile_facts', { kind: 'nonsense' }),
    ok: (r) => r.ok === false && /not empty/i.test(r.hint ?? ''),
  },
  {
    name: 'open_job with no id says the field is missing',
    run: () => call('open_job', {}),
    ok: (r) => r.ok === false && r.error === 'missing_job_id',
  },
]

for (const [tool, args, label] of malformed) {
  // Reset between cases so a leftover pending edit cannot mask the real answer.
  await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })
  await call('open_job', { jobId: JOB_A })
  const res = await call(tool, args)
  const threw = res?.__threw
  const hasSummary = typeof res?.summary === 'string' && res.summary.length > 0
  check(`${tool} — ${label}`,
    !threw && (res.__missing || hasSummary),
    threw ? `THREW: ${threw}` : (res.summary ?? '').slice(0, 90))
}

// ===================================================================
console.log('\n=== C2. RESPONSES THAT COULD TEACH A WRONG BELIEF ===')
for (const b of beliefs) {
  await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })
  const res = await b.run()
  check(b.name, !res.__threw && b.ok(res), (res.summary ?? res.hint ?? '').slice(0, 105))
}

// ===================================================================
console.log('\n=== D. SUBMIT OUT OF ORDER ===')
await page.goto(`${URL}?reset=1`, { waitUntil: 'networkidle' })

r = await call('submit_application', {})
check('submit with nothing prepared refuses',
  r.__missing || wellFormedRefusal(r) === null,
  r.__missing ? 'not registered (correct)' : (wellFormedRefusal(r) ?? r.summary))

await call('open_job', { jobId: JOB_A })
await call('prepare_application', { coverNote: 'I would be glad to bring this work to your team.', sourceFactIds: [] })
r = await call('prepare_application', { coverNote: 'Second attempt, same job.', sourceFactIds: [] })
check('prepare_application twice is a clean re-prepare, not a duplicate',
  r.ok === true && /ready/i.test(r.summary), r.summary?.slice(0, 90))
const appCount = await page.evaluate(() => window.__mcp.call('get_applications').then((x) => x.applications.length))
check('re-preparing does not create a second application', appCount === 1, `applications: ${appCount}`)

// Close the job, then submit: the prepared application should still be sendable.
await page.locator('.detail__head .link', { hasText: 'close' }).click()
await page.waitForTimeout(200)
const submitStillThere = (await names()).includes('submit_application')
check('closing the job leaves a prepared application submittable',
  submitStillThere, `submit_application registered: ${submitStillThere}`)

await page.evaluate(() => { window.__p = window.__mcp.call('submit_application', {}) })
await page.waitForTimeout(250)
const modal = await page.locator('.modal').isVisible()
check('submit opens the confirmation modal', modal, `modal visible: ${modal}`)
await page.locator('.modal .btn', { hasText: 'Cancel' }).click()
const cancelled = await page.evaluate(() => window.__p)
check('cancelling returns user_declined with a summary',
  cancelled.ok === false && cancelled.error === 'user_declined' && !!cancelled.summary,
  cancelled.summary?.slice(0, 90))

// ===================================================================
console.log(`\n${'='.repeat(68)}`)
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} behaved as expected`)
if (failed.length) {
  console.log('\nFAILURES:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
console.log('uncaught page errors:', pageErrors.length ? pageErrors : 'none')

await browser.close()
process.exitCode = failed.length > 0 || pageErrors.length > 0 ? 1 : 0
