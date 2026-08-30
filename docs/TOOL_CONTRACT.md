# Tailor — WebMCP Tool Contract

> Specification document. This is the single source of truth for the agent-facing
> surface of the app. Code follows this document; if code and document disagree,
> the document wins until it is deliberately amended.

## 1. What the product is

Tailor is a job board where the resume is a first-class, editable object and an AI
agent is a first-class user of the page — alongside the human, not instead of them.

The agent can search jobs, read the user's fact bank, and **propose** resume
rewrites tailored to a specific posting. It cannot silently change the resume, and
and every claim it writes must be grounded in a fact the user recorded. Every
write is either reviewable (a diff the human accepts or rejects) or gated behind
an explicit confirmation.

**An agent that can rewrite your resume, but not rewrite your experience.**

WebMCP turns the resume into an evidence-bound workspace: the agent proposes,
the page constrains, the human approves.

> **What the constraint is, precisely.** The page checks *grounding*: every
> technology, number and name in a proposed line must trace to a fact the user
> recorded, or to the text already in the block. That is not a truth check — the
> page cannot know whether the user's own record is accurate. It is also not an
> entailment check: a sentence assembled from two true facts can describe
> something that never happened, and grounding will pass it. That gap is real,
> documented, and surfaced to the human rather than hidden.

### Non-goals

- No server-side LLM calls. The intelligence lives in the user's agent. The page
  exposes capability, not cognition.
- No user accounts, no backend database. All state is local (`localStorage`).
- No live job API at runtime. Job data is a build-time snapshot of real postings.

## 2. State model

```ts
type Fact = {
  id: string;              // "f_react_5y"
  kind: "skill" | "role" | "achievement" | "education" | "language";
  text: string;            // "Built and shipped 4 React SPAs at Acme, 2021-2024"
  tokens: string[];        // ["react", "spa", "acme"] — normalised, used by the guard
};

type ResumeBlock = {
  id: string;              // "b_summary", "b_exp_acme_1"
  section: "summary" | "experience" | "skills" | "education";
  text: string;
  sourceFactIds: string[]; // provenance; empty only for the untailored baseline
};

type JobTag = {
  tag: string;             // canonical vocabulary name, e.g. "kubernetes"
  evidence: string;        // ~140-char window quoted from the FULL posting
  required: boolean | null;// true = hard requirement, false = nice-to-have,
                           // null = could not be determined. Never guessed.
};

type Job = {
  id: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  seniority: "junior" | "mid" | "senior" | "lead";
  minYears: number | null;
  tags: JobTag[];          // normalised tech tags, each carrying its evidence
  tagNames: string[];      // derived — tags.map(t => t.tag), for cheap filtering
  description: string;     // truncated to 1400 chars; full text stays at `url`
  url: string;
  postedAt: string;        // ISO date
  source: string;          // which public API this posting came from
};

type PendingEdit = {
  id: string;              // "e_1"
  jobId: string;
  targetBlockId: string;
  before: string;
  after: string;
  rationale: string;       // why this helps for THIS job
  sourceFactIds: string[];
  status: "pending" | "accepted" | "rejected";
};

type Application = {
  jobId: string;
  resumeSnapshot: ResumeBlock[];
  coverNote: string;
  status: "draft" | "ready" | "submitted";
  submittedAt: string | null;
};
```

> **Amendment (deliberate).** `tags` was originally `string[]`. It is now
> `JobTag[]`, with `tagNames: string[]` derived alongside so filtering stays as
> cheap as it was, plus a `source` field for attribution.
>
> **Why evidence exists.** `description` is truncated to 1400 characters, but a
> tag is detected against the *full* posting text. Without a quoted window, the
> app could tell the user "this job requires Kubernetes" while the requirement
> sits in text the user cannot see — an unverifiable claim, which is precisely
> the failure mode this product exists to prevent. The guard must not commit the
> error it refuses on the agent's behalf. Every tag therefore carries the
> sentence it came from, and `required` is left `null` rather than guessed when
> the posting's structure does not make it clear.

## 3. Tool inventory

| Tool | Kind | Available when | Purpose |
|---|---|---|---|
| `get_workspace_state` | read | always | Orientation: what's on screen right now |
| `get_profile_facts` | read | always | The fact bank — the only legal source of resume claims |
| `get_resume` | read | always | Current resume blocks with ids |
| `get_applications` | read | always | Application tracker |
| `search_jobs` | write | always | Apply filters, update the visible list |
| `open_job` | write | always | Select a job, open the detail pane |
| `get_job_details` | read | a job is open | Full posting text + parsed requirements |
| `get_fit_gaps` | read | a job is open | Deterministic match: covered vs missing requirements |
| `propose_resume_edits` | write | a job is open | Queue a reviewable diff. **Never applies directly.** |
| `withdraw_edit` | write | ≥1 pending edit | Retract a proposal (e.g. to replace it after a rejection) |
| `request_profile_fact` | write | always | Ask the human to add a fact. Agent cannot add one itself. |
| `prepare_application` | write | a job is open, 0 pending edits | Fill the application form, return a preview |
| `submit_application` | write | application is `ready` | Send it — blocks on a human confirmation dialog |

13 tools: 6 read, 7 write. Read tools carry `annotations: { readOnlyHint: true }`.

## 4. Tool specifications

Common rules for every tool:

- `inputSchema` uses `additionalProperties: false` and marks required fields.
- `execute` receives `(args, { signal })` and must honour the `AbortSignal`.
- Every return value is an object with a `summary` string (one line, human
  readable, what the agent will likely quote back) plus structured fields.
- Errors are returned, never thrown: `{ ok: false, error: "...", hint: "..." }`.
  The `hint` tells the agent how to fix its own call.
- Tools reuse the same application logic the UI buttons call. No parallel code path.

---

### `get_workspace_state`

Orientation tool. The agent is expected to call this first in a new task.

**Input:** `{}`

**Returns:**
```json
{
  "summary": "Job list showing 12 of 84 jobs. 'Senior React Engineer at Linear' is open. 3 pending edits await your review.",
  "activeFilters": { "query": "react", "remote": true, "seniority": null, "maxYears": 3 },
  "visibleJobCount": 12,
  "totalJobCount": 84,
  "openJobId": "j_linear_react" ,
  "pendingEditCount": 3,
  "applicationCounts": { "draft": 1, "ready": 0, "submitted": 2 }
}
```

---

### `get_profile_facts`

**Input:** `{ kind?: "skill" | "role" | "achievement" | "education" | "language" }`

**Returns:** the fact bank. Each fact carries its `id`. The agent must reference
these ids in `propose_resume_edits`.

```json
{
  "summary": "17 facts on file: 9 skills, 4 roles, 3 achievements, 1 education.",
  "facts": [
    { "id": "f_react_4y", "kind": "skill", "text": "React, 4 years, production" }
  ]
}
```

---

### `get_resume`

**Input:** `{ section?: "summary" | "experience" | "skills" | "education" }`

**Returns:** resume blocks with ids, current text, and which job (if any) the
current version was tailored for.

---

### `get_applications`

**Input:** `{ status?: "draft" | "ready" | "submitted" }`

**Returns:** the tracker rows. Used for "what have I already applied to?"

---

### `search_jobs`

Applies filters to the live UI and returns matching summaries. This is a write
tool because it changes what the human sees on screen — that is the point.

**Input:**
```json
{
  "type": "object",
  "properties": {
    "query":      { "type": "string", "description": "Free text over title, company, description." },
    "remote":     { "type": "boolean" },
    "seniority":  { "type": "string", "enum": ["junior", "mid", "senior", "lead"] },
    "maxYears":   { "type": "integer", "minimum": 0, "maximum": 20,
                    "description": "Exclude postings demanding more than this many years." },
    "tags":       { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
    "limit":      { "type": "integer", "minimum": 1, "maximum": 25, "default": 10 }
  },
  "additionalProperties": false
}
```

**Behaviour:** replaces the current filter set (not additive — the agent passes the
full intended filter state each time; this keeps it predictable). Scrolls the list
to top. Returns at most `limit` summaries.

**Returns:**
```json
{
  "summary": "12 jobs match. Showing 10. Filters are now visible in the sidebar.",
  "matchCount": 12,
  "jobs": [
    { "id": "j_linear_react", "title": "Senior React Engineer", "company": "Linear",
      "remote": true, "minYears": 3, "tags": ["react", "typescript"] }
  ]
}
```

---

### `open_job`

**Input:** `{ jobId: string }`

**Behaviour:** selects the job, opens the detail pane, and **registers the
job-scoped tools** (`get_job_details`, `get_fit_gaps`, `propose_resume_edits`,
`prepare_application`). Closing the job or opening a different one aborts the
previous registrations.

**Returns:** `{ summary, job, newlyAvailableTools: [...] }`

Naming the newly available tools in the return value is deliberate: it tells the
agent that its capability set just changed without waiting for a `toolchange`
round trip.

---

### `get_job_details`

**Input:** `{}` — operates on the open job.

**Returns:** full description plus the app's parsed requirement list
(`requiredTags`, `niceToHaveTags`, `minYears`). Parsing is done by existing app
logic so the agent and the human see the same interpretation.

Those three lists are **derived from `Job.tags`, not parsed a second time**:

```ts
requiredTags    = tags.filter(t => t.required === true)
niceToHaveTags  = tags.filter(t => t.required === false)
unclassifiedTags= tags.filter(t => t.required === null)
```

Each entry keeps its `evidence` string, so the agent can quote the sentence a
requirement came from and the human can check it against the linked posting.
`unclassifiedTags` is deliberately a third list rather than being folded into
either of the other two: the build step could not determine the requirement's
strength, and silently promoting it to "required" would manufacture a
requirement the posting never stated.

```json
{
  "summary": "Senior ML Engineer at US LBM. 9 required, 3 nice-to-have, 4 unclassified.",
  "requiredTags": [
    { "tag": "computer vision", "evidence": "…Build computer vision models, OCR, and parsing techniques for images and PDFs…" }
  ],
  "niceToHaveTags": [
    { "tag": "docker", "evidence": "…is a plus. Deployment & Infrastructure - AWS/Azure/GCP; Docker, Kubernetes…" }
  ],
  "unclassifiedTags": [ { "tag": "python", "evidence": "…Stack: Python, SQL, Pandas, NumPy…" } ],
  "minYears": 5
}
```

---

### `get_fit_gaps`

Deterministic, app-computed comparison. No language model judgement involved —
this is what makes the agent's later claims checkable.

**Input:** `{}`

**Returns:**
```json
{
  "summary": "Covered 6 of 8 requirements. Missing: Kubernetes, GraphQL.",
  "covered":  [ { "tag": "react", "factIds": ["f_react_4y"] } ],
  "missing":  [ "kubernetes", "graphql" ],
  "yearsGap": 0
}
```

The `missing` list is the agent's cue to call `request_profile_fact` rather than to
invent something.

**Both sides resolve through one alias table.** A job tag and a fact token are
compared only after each is mapped to its canonical vocabulary name. This is not
a refinement; without it the tool reports false gaps. The market writes "TTS",
"STT" and "ASR"; this profile writes "text to speech" and "speech recognition",
and those spelled-out forms appear in **zero** of the 175 fetched postings. A
literal string comparison therefore told a candidate with shipped speech systems
that he lacked speech experience.

A false negative is as damaging as a false positive here. A false positive makes
the agent claim something untrue; a false negative makes the app tell the user to
go and acquire a skill he already has — and, worse, suppresses the fact that
would have supported a legitimate resume line. The guard exists to keep claims
honest in both directions.

Aliases are derived from the corpus by measurement, never from intuition. Forms
whose corpus usage is dominated by another meaning are excluded from job-text
matching even when they look obvious — `cv` is resume roughly half the time,
`serving` is "serving 50,000+ customers", `classification` is overwhelmingly
*text* classification, and `offline` means offline *evaluation*. Such forms may
still resolve a profile token, where they are unambiguous, but they must never
tag a posting.

---

### `propose_resume_edits`

The core tool. **It queues a diff for human review. It never mutates the resume.**

**Input:**
```json
{
  "type": "object",
  "properties": {
    "edits": {
      "type": "array", "minItems": 1, "maxItems": 8,
      "items": {
        "type": "object",
        "properties": {
          "targetBlockId": { "type": "string" },
          "newText":       { "type": "string", "maxLength": 400 },
          "rationale":     { "type": "string", "maxLength": 200,
                             "description": "Why this wording helps for THIS posting." },
          "sourceFactIds": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
        },
        "required": ["targetBlockId", "newText", "rationale", "sourceFactIds"],
        "additionalProperties": false
      }
    }
  },
  "required": ["edits"],
  "additionalProperties": false
}
```

**The fact guard.** Before an edit is queued, the app validates:

1. Every `sourceFactIds` entry exists in the fact bank.
2. Every capitalised term, technology token, and number in `newText` appears
   either in the referenced facts' `tokens` or in the original block text.
3. `newText` differs meaningfully from `before` (not a whitespace change).

An edit failing any check is **not queued**. It comes back as a rejection with a
reason, so the agent can correct itself in the next turn.

**Returns:**
```json
{
  "summary": "2 of 3 edits queued for review. 1 rejected: unsupported claim 'Kubernetes'.",
  "queued":   [ { "editId": "e_4", "targetBlockId": "b_summary" } ],
  "rejected": [ { "targetBlockId": "b_skills", "reason": "unsupported_claim",
                  "offendingTokens": ["kubernetes"],
                  "hint": "No fact supports this. Call request_profile_fact to ask the user, or drop the claim." } ]
}
```

---

### `withdraw_edit`

**Input:** `{ editId: string }`

Removes a still-pending proposal. Used when the human rejects an edit and the
agent wants to offer a different wording, or when the agent changes its mind.
Cannot touch an already-accepted edit.

---

### `request_profile_fact`

The agent may **never** write to the fact bank. It can only open a pre-filled form
and ask.

**Input:**
```json
{
  "claim": "string — the fact as the agent understood it",
  "kind":  "skill | role | achievement | education | language",
  "why":   "string — why this job makes it worth adding"
}
```

**Behaviour:** opens a small panel with the claim pre-filled and editable. The
human saves, edits, or dismisses it. The tool resolves immediately with
`awaiting_user`, it does not block — the agent should continue and re-read
`get_profile_facts` later.

**Returns:** `{ summary: "Asked the user to confirm: 'Kubernetes, production experience'.", status: "awaiting_user" }`

---

### `prepare_application`

**Input:** `{ coverNote: string (max 900 chars) }`

**Preconditions:** a job is open, and there are **zero pending edits** — the human
must have cleared the review queue first. If edits are pending, the tool returns
an error naming the count. This ordering constraint is the whole human-in-the-loop
story in one rule.

**Behaviour:** builds the application from the *accepted* resume state, fills the
form fields visibly on screen, sets status to `ready`, and registers
`submit_application`.

**Returns:** `{ summary, preview: { fields... }, missingRequiredFields: [] }`

---

### `submit_application`

The only consequential action in the app.

**Input:** `{}`

**Behaviour:** opens a modal showing exactly what will be sent. Resolves only when
the human clicks Submit or Cancel. Honours `signal` — if the agent turn is aborted,
the modal closes and the promise rejects.

**Returns on confirm:** `{ ok: true, summary: "Application to Linear submitted.", applicationId, submittedAt }`
**Returns on cancel:** `{ ok: false, error: "user_declined", hint: "The user cancelled. Ask what they want changed." }`

`annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }`

## 5. Dynamic tool lifecycle

Tools are not registered once at boot. The registered set mirrors what is
actually possible right now.

```
always                         → get_workspace_state, get_profile_facts, get_resume,
                                 get_applications, search_jobs, open_job,
                                 request_profile_fact
job open                       → + get_job_details, get_fit_gaps, propose_resume_edits
≥1 pending edit                → + withdraw_edit
job open AND 0 pending edits   → + prepare_application
application status = ready     → + submit_application
```

Implementation: one `AbortController` per scope. Closing a job calls
`controller.abort()`, which unregisters that scope's tools in one operation.
The UI shows a small "N tools available to your agent" indicator so the human can
see the surface change too — this is worth demoing.

## 6. Rules the implementation must follow

From OpenAI's site-tools guidance, applied to this project:

- **Keep inputs narrow.** Enums over free strings wherever the domain is closed.
- **Describe side effects in the description string.** The agent reads it, and so
  does the human in the Site tools panel. Write descriptions for both audiences.
- **Return enough to verify.** Every write tool returns the resulting state, not
  just "ok".
- **Reuse existing logic.** A tool calls the same store action the UI button calls.
  If a tool can do something the UI cannot, that is a bug.
- **Preserve the normal interface.** The app must be fully usable with zero agent
  involvement, in a browser with no WebMCP support. Feature-detect
  `document.modelContext?.registerTool` and degrade silently.
- **No tools inside iframes.** ChatGPT's built-in browser does not discover them.
  Everything registers on the top-level page.
- **No declarative API.** Not supported in the built-in browser. JavaScript only.

## 7. Demo script this contract is built to serve

1. `get_workspace_state` → agent orients itself.
2. "Find remote React roles that don't demand 5+ years" → `search_jobs`.
   Filters visibly move in the sidebar.
3. "Open the Linear one" → `open_job`. Tool count on screen goes from 7 to 10.
4. "Tailor my resume for it" → `get_profile_facts`, `get_fit_gaps`,
   `propose_resume_edits`. Three diffs appear, each with a rationale.
5. Human rejects one → agent calls `withdraw_edit` and proposes different wording.
6. "Say I know Kubernetes" → **rejected by the fact guard.** Agent calls
   `request_profile_fact` instead. This is the moment the demo is built around.
7. Human accepts remaining edits → `prepare_application` unlocks.
8. "Send it" → `submit_application` → confirmation modal → human clicks → done.

Roughly 150 seconds. Every beat exercises a different part of the contract.
