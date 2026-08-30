# Tailor

A job board where the résumé is an editable object and an AI agent is a first-class
user of the page, working alongside the human rather than instead of them. The agent
can search postings, read the user's fact bank and propose résumé rewrites — but it
cannot invent experience the user never claimed, and every change is a diff the human
accepts or rejects.

The differentiator is not "AI writes your résumé". It is **"AI writes your résumé and
cannot lie, and you approve every line."**

---

## No server-side model call, by design

There is no backend, no API key and no LLM call anywhere in this codebase. The page
exposes **capability, not cognition**.

That is the WebMCP-native choice rather than a shortcut. WebMCP lets a page register
tools that the *user's own agent* calls. The intelligence is already in the room — it
is the agent the user brought. A page that also called a model would be second-guessing
it, and would need a key, a backend, and a per-user cost.

It also puts the trust boundary in the right place. The page's job is not to be smart;
it is to be **checkable**. `get_fit_gaps` is a deterministic set comparison, not a
judgement. The fact guard is string matching over a controlled vocabulary. Neither
involves a model, which is exactly why the agent's claims can be verified rather than
believed. If the page reasoned, there would be nothing to check it against.

Concretely: 13 tools, all synchronous reads or state changes over local data. The
heaviest computation is a regex scan.

---

## The fact guard

Every résumé edit and the cover note pass through the same check. An edit is queued
only if **every technology term, product name, number, superlative and seniority claim
in the new text is grounded** — meaning it appears in a cited fact or was already in the
block being rewritten.

Refusals name the offending tokens, so the agent can correct itself rather than retry
blindly.

### A refusal

```jsonc
// agent calls propose_resume_edits
{
  "targetBlockId": "b_skills",
  "newText": "Backend: FastAPI, Flask, Docker, Linux, Git. Familiar with Kubernetes and TensorFlow.",
  "rationale": "The posting lists them.",
  "sourceFactIds": ["f_backend"]
}
```
```jsonc
// refused — f_backend says nothing about either
{
  "reason": "unsupported_claim",
  "offendingTokens": ["tensorflow", "kubernetes"],
  "hint": "Nothing in the cited facts or the original block supports: tensorflow, kubernetes.
           Either cite a fact that does, call request_profile_fact to ask the user, or drop the claim."
}
```

Hedging does not help: *"familiar with"*, *"exposure to"*, *"working knowledge of"* all
refuse, because the token is still there. Nor does dropping the number — `"near-perfect
accuracy"` is refused as a superlative standing in for a metric, and `"Led the team"` is
refused as a seniority claim no fact supports.

### A true claim passing cleanly

```jsonc
{
  "targetBlockId": "b_exp_wagon",
  "newText": "Three-stage computer vision pipeline for railway wagons: detection mAP@50 0.994
              and ResNet18 recognition at 99.76% validation accuracy.",
  "sourceFactIds": ["a_wagon_pipeline", "a_wagon_metrics"]
}
```
Queued. Every technology resolves to a cited fact, and both numbers appear verbatim in
`a_wagon_metrics`. Round `0.994` to `0.99+` and it is refused — rounding a metric invents
a different metric.

`npm run guard-tests` runs 30 adversarial cases: hedging, metric inflation, spelled-out
counts ("six" → "twenty"), invented scale, invented employers, puffery, unquantified
leadership, and structural misuse. 29 behave as expected; **zero true claims are
refused**, which matters as much as the refusals.

### The leak: compositional claims

**Token matching cannot see entailment. This is not solved.**

```
"Built an OCR pipeline that reads structured fields directly from X-ray scans."
  cites a_ocr_declaration (OCR on scanned documents) + a_xray_loaded (X-ray classifier)
```

Every ingredient is attested. The sentence asserts a combination neither fact supports —
those two projects never met. The guard passes it, and no amount of token checking will
catch it; that needs entailment.

Rather than pretend otherwise, the app **surfaces it to the human**. Any edit citing more
than one distinct project is flagged in the diff:

> **Combines 2 separate pieces of work — verify this one.** Each term is backed by a cited
> fact, but nothing checks that the combination describes something that actually happened.

The failing case is kept in the test suite as an expected failure. It is surfaced, not
solved, and the human is the check.

---

## Leading questions: three layers, each because the last one failed

The agent can ask the user to add a fact (`request_profile_fact`). It cannot write one —
that is proven, not assumed: `npm run misuse-tests` fires all 13 tools with arguments
designed to write a fact and asserts the bank is byte-identical afterwards.

But *asking* has its own failure mode, and finding it took three attempts. Each layer
exists because a real ChatGPT session showed the previous one was not enough.

**Layer 1 — the description.** The original read *"Ask the human to add a fact… use it
when get_fit_gaps reports something missing that you believe the candidate actually has."*

> A live session: the agent replied **"Once you confirm, I'll add your TensorFlow and
> Kubernetes experience to the local profile fact bank."**

It believed it could write. The description had taught it that. Rewritten to open with
**DOES NOT ADD ANYTHING**, state that no tool writes to the bank, and say plainly that a
missing requirement is evidence the user does *not* have it.

**Layer 2 — the description was not enough.**

> Next session: the agent correctly said *"the app prevents me from inserting them until
> they're confirmed in your profile"* — and then opened profile questions for TensorFlow
> and Kubernetes anyway, purely because `get_fit_gaps` listed them missing.

It read the instruction and did it anyway. Descriptions are guidance, not enforcement.
So `request_profile_fact` now detects when a claim names a concept **the open posting
requires and the fact bank does not support**, and returns a warning that leads the
summary, instructing the agent to relay it.

**Layer 3 — the agent might not relay it.** Layer 2 depends on the agent's cooperation,
and layer 1 already proved that is not reliable. So the same warning appears on screen,
where it does not depend on the agent at all:

> **This question came from the job posting, not from your profile.** Nothing you have
> recorded mentions kubernetes, and this posting requires it. Add it only if you have
> genuinely done this work. A posting asking for something is not a reason to claim it.

The confirm button reads **"Yes, I have done this"**, not "Add to fact bank" — a claim
about yourself, not an administrative step.

**It warns rather than refuses, deliberately.** The app cannot hear the conversation, so
it cannot distinguish *the agent inferred this from a gap* from *the user just said they
know Kubernetes* — and the second is legitimate. Refusing would block the honest case to
stop the dishonest one. The app declines to help construct a leading question silently;
it does not decide for the user.

---

## The alias layer, and a false negative that matters

Job postings and résumés describe the same skill with different words. The corpus writes
**TTS**, **STT** and **ASR**. This profile writes *"text to speech"* and *"speech
recognition"* — forms that appear in **zero** of the 175 fetched postings.

A literal string comparison therefore told a candidate with shipped speech systems that
he lacked speech experience. That is the classic ATS failure: a real qualification
discarded because the wording differs. **A false negative is as damaging as a false
positive** — it tells someone to go and acquire a skill they already have, and suppresses
the fact that would have supported a legitimate résumé line.

Every `TECH` entry is now `{ canonical, aliases, profileAliases }`, and job tags and fact
tokens resolve through the same table — 65 concepts, 207 surface forms. `f_speech`
resolves to `speech`, which matches the 9 postings tagged that way.

Aliases are **derived from the corpus by measurement, not intuition**, and three obvious
ones were measured and rejected:

| Alias | Measurement | Verdict |
|---|---|---|
| `cv` → computer vision | 10 hits, ~half are *"apply with your CV"* | rejected |
| `serving` → model deployment | 37 hits, mostly *"serving 50,000+ customers"* | rejected |
| `classification` → image classification | 16 hits, ~80% *text* classification | profile-only |

`ray` is hyphen-guarded: the word-boundary matcher treats `-` as a separator, so **"X-ray"
would otherwise match the Ray framework** — and this profile is full of X-ray inspection
work.

---

## Job data

120 real postings, 115 remote, 1,099 evidence-carrying tags (541 required, 141
nice-to-have, 417 unclassified). Fetched at build time from four free, no-key public APIs
using Node's built-in `fetch` and no dependencies:

**[Jobicy](https://jobicy.com/) · [Himalayas](https://himalayas.app/) ·
[Arbeitnow](https://www.arbeitnow.com/) · [Remotive](https://remotive.com/)**

Every row keeps a `source` field and a canonical `url`. Descriptions are truncated to
1,400 characters — the full text stays on the original site. We link out, we do not
republish.

```bash
npm run fetch-jobs     # rewrites src/data/jobs.json and src/data/vocabulary.json
```

Each tag carries a ~140-character **evidence** quote from the *full* posting, because the
stored description is truncated. Without it the app could say "this job requires
Kubernetes" while the requirement sat in text the user cannot see — an unverifiable claim,
which is precisely what this product exists to prevent. The guard must not commit the
error it refuses on the agent's behalf.

`required` is best-effort and **`null` when undetermined**, never guessed. Unclassified
tags are a third list rather than being folded into "required", because promoting them
would manufacture a requirement the posting never stated.

---

## Dynamic tool lifecycle

The registered tool set mirrors what is actually possible right now. The names are shown
in a rail across the top of the app, grouped by scope, and additions and removals animate.

```
7  at rest        get_workspace_state · get_profile_facts · get_resume · get_applications
                  search_jobs · open_job · request_profile_fact

11 job open       + get_job_details · get_fit_gaps · propose_resume_edits · prepare_application

11 edits pending  + withdraw_edit, − prepare_application   ← same count, different surface

12 ready to send  + submit_application
```

Each scope is one `AbortController`; closing a job aborts it and unregisters that scope in
a single operation.

**Why scope beats a runtime check.** `prepare_application` requires a job open *and* zero
pending edits — the human-in-the-loop rule in one line. Implemented as a runtime guard, the
tool would exist and refuse. Implemented as scope, **it is not registered at all**: the
agent cannot call it, so it cannot form a plan around calling it. The refusal still exists
for a stale reference held from an earlier turn, but it is the second line of defence, not
the first.

Note the third row: queueing an edit swaps `prepare_application` out for `withdraw_edit`.
The count is unchanged while the surface is meaningfully different — which is why the rail
shows names rather than a number.

Every scope change is also **self-describing**, because an agent that finds a tool missing
has nothing to read:

> `1 of 1 edit queued for review. Now available: withdraw_edit. No longer available:
> prepare_application (needs a job open and no edits pending review).`

---

## Running it

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # tsc -b && vite build
```

The app is fully usable by hand in a browser with no WebMCP support —
`document.modelContext` is feature-detected and the status strip says
"WebMCP not detected" rather than implying a tool surface that is not there.

```bash
npm run guard-tests      # 30 adversarial guard cases   (needs npm run dev)
npm run misuse-tests     # 41 agent-misuse cases        (needs a built preview)
```

`?reset=1` restores the shipped demo data and strips itself from the URL, so a shared
machine always starts clean. There is also a reset control in the top strip.

### Testing it in ChatGPT's built-in browser

Open the deployed URL in ChatGPT's browser. The strip should read **WebMCP active**.

1. *"What can you do on this page?"* → `get_workspace_state`, 7 tools.
2. *"Find remote computer-vision roles that don't want 5+ years"* → `search_jobs`; the
   sidebar filters visibly move.
3. *"Open the US LBM one"* → `open_job`; the rail goes 7 → 11.
4. *"How well do I fit?"* → `get_fit_gaps` — 19 of 29 requirements evidenced, 2 years short
   of 3, with the fact its years figure came from.
5. *"Tailor my résumé for it"* → `propose_resume_edits`; diffs appear for review.
6. **"Say I know Kubernetes"** → refused, offending token named. The agent should offer to
   ask you rather than rewording it. If it opens a profile question, the on-screen notice
   should tell you the question came from the posting and not from your profile.
7. Accept the rest → `prepare_application` re-registers → *"Send it"* → confirmation modal.

Nothing is sent without a human click, and aborting the turn closes the modal.

---

## Known limitations

**Compositional claims get through.** Described above. Every ingredient attested, the
combination invented. Flagged for the human, not blocked. Fixing it properly needs
entailment checking, which a token matcher cannot do.

**The leading-question flag only fires while a job is open.** It compares the claim against
the open posting's requirements, so with no job open there is nothing to compare against
and nothing is flagged. Widening it to "any tag the profile lacks" would flag legitimate
bank-completion questions too, which seemed worse.

**140 KB brotli in one bundle, not split.** The job snapshot is 74 KB of that. Splitting it
behind a dynamic import was measured and rejected: the job list *is* the first paint, so the
bytes are on the critical path either way, and on a bandwidth-limited link parallelism saves
nothing. The measured gain was ~40 ms of parse time; the cost was gating tool registration on
an async load, with a failure mode where a dropped fetch leaves tools registered against no
data. A race condition is worse than 40 ms.

**`sourceSpread` groups projects by fact-id stem** (`a_wagon_*` → one project). A naming
convention doing semantic work. Fine for 32 facts; it would not survive a bank ten times the
size, where a `project` field on the fact would be the honest fix.

**Descriptions cannot be unit-tested.** The misuse suite calls tools directly, so it can prove
the fact bank is unwritable but not that an agent will not *claim* it wrote to it. That gap is
only closable by running real sessions — which is how all three leading-question layers were
found.

---

## Layout

```
docs/TOOL_CONTRACT.md     the spec; code follows it, and it wins when they disagree
docs/ABSENT_TERMS.md      what the fact bank deliberately does not contain, and why
scripts/fetch-jobs.mjs    build-time fetcher, no dependencies
scripts/guard-tests.mjs   adversarial guard suite
scripts/agent-misuse-tests.mjs   agent-shaped misuse suite
src/lib/guard.ts          the fact guard
src/lib/match.ts          alias resolution, filtering, fit gaps
src/store.ts              one store; UI actions and tool executes call the same functions
src/tools.ts              WebMCP registration and scope lifecycle
```

If a tool can do something no button can, that is a bug — which is why there is exactly one
implementation of each action.

## License

MIT — see [LICENSE](LICENSE).
