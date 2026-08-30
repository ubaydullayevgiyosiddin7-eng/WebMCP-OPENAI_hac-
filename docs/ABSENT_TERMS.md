# The negative set — what the fact bank deliberately does not contain

A fact guard can only be demonstrated against something it genuinely refuses.
This document lists the technologies the profile in `src/data/profile-facts.json`
does **not** cover, and explains why that list is a designed part of the system
rather than a gap to be filled in before a demo.

It is design rationale, kept in `docs/` rather than in the data. It is not
shipped to the browser: `profile-facts.json` contains only positive facts, so
the client bundle carries no list of absences. That is a build property you can
verify — grep the bundle.

## Why a negative set is required

Tailor's claim is that the agent cannot invent experience. That claim is
untestable unless some of what employers ask for is genuinely absent from the
fact bank.

If every technology in the job corpus happened to appear somewhere in the
profile, the guard would never fire. The central moment — an agent asked to
write "familiar with Kubernetes" and refusing because nothing supports it —
would be staged rather than real, and a reviewer would be right to discount it.

So these absences are load-bearing. They are also, deliberately, the terms that
occur most often in real ML postings: of the 120 fetched jobs, 36 ask for
TensorFlow, 50 for AWS and 29 for Kubernetes. The refusal happens naturally in the
course of using the app, which is the only way it means anything.

Two rules follow, and they are the reason this file exists as a written
commitment rather than an assumption:

- **Nothing here may be added to the fact bank to improve a match.** A fact is
  added because the work was done, never because a posting wants it. See the
  leading-question warning in `request_profile_fact` — the app actively resists
  being used to construct the opposite.
- **The guard must refuse these even when refusing is unhelpful.** Silently
  dropping an unsupported claim is correct behaviour. Softening it into
  "exposure to Kubernetes" is not, and the guard rejects that too.

## The absent terms, and why each one is a useful test

**Deep-learning frameworks other than PyTorch** — TensorFlow, Keras, JAX.
The profile's training work is PyTorch. Postings routinely list "PyTorch or
TensorFlow" as interchangeable, which makes this the most frequent near-miss in
the corpus and the cleanest refusal to demonstrate: the sentence reads fine, one
token is unsupported.

**Orchestration and infrastructure-as-code** — Kubernetes, Terraform, Helm.
The profile covers Docker on Linux, deployed to on-premise servers inside a
closed network. That is real deployment experience and the guard credits it; it
is not cluster orchestration, and the two must not be conflated. A good test of
whether the alias layer over-reaches.

**Public cloud** — AWS, GCP, Azure, SageMaker.
The deployment work in the profile is air-gapped by requirement: the models run
on local hardware because the data cannot leave the network. The absence is a
property of the problem domain, which makes it a realistic gap rather than an
artificial one.

**Data platforms at scale** — Spark, Kafka, Airflow, MLflow, Kubeflow.
Training and inference pipelines are covered; distributed data platforms and
managed experiment tracking are not.

**Frontend** — React, TypeScript, Node.js.
Absent entirely. Postings pairing ML with frontend duties are a genuine
mismatch, and the app should report them as one.

**Other languages** — Java, C++, Go, Rust. Python is the working language.

**Warehousing and BI** — Snowflake, dbt, BigQuery.

**Seniority and duration claims** — "5 years experience", "10 years
experience", "team lead", "managed a team".
The profile states one year in the current role. Postings asking for five-plus
years produce a real years-gap, and `get_fit_gaps` reports it as a number with
its basis rather than letting it be written around. The guard also refuses
unquantified leadership verbs — "Led the team" carries a claim that no fact
supports, and no number trips the numeric check.

## Maintenance

When something here is genuinely earned, move it: delete the entry and add a
fact with an honest `tokens` list. The two documents must never both claim the
same thing. If a term appears in the fact bank and here, the fact bank is wrong
until proven otherwise.
