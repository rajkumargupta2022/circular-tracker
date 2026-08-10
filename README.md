# NSE Circular Tracker

Watches the **Mutual Fund** department circulars on NSE India every day, stores new
ones in SQLite, decides which are operationally important, and emails stakeholders
when something needs attention — downtime, suspensions, cut-off changes, mock
sessions.

Routine NFO launches (which dominate the feed) are recorded but never emailed.

## How it works

```
cron tick
   │
   ├─ 1. bootstrap an NSE session       cookies from the circulars page (the API
   │                                     403s without them; the homepage 403s too,
   │                                     so the circulars page is the entry point)
   ├─ 2. fetch a rolling window          last NSE_LOOKBACK_DAYS days, so a missed
   │                                     run self-heals on the next one
   ├─ 3. drop what we already have       matched on circular number (NSE/NMF/75630)
   │                                     — happens BEFORE classification, so a
   │                                     re-fetch costs nothing and never re-spends
   │                                     LLM tokens
   ├─ 4. classify the genuinely new      keyword rules first; Claude only for the
   │                                     ambiguous middle band
   ├─ 5. store                            SQLite, one row per circular
   └─ 6. email                            one HTML digest of everything critical or
                                          important that hasn't been sent yet
```

## Setup

```bash
npm install
cp .env.example .env      # then edit it
npm run build
```

Minimum you must set in `.env` to get alerts: `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS`, `MAIL_TO`. Everything else has a working default.

For Gmail, `SMTP_PASS` must be an [App Password](https://myaccount.google.com/apppasswords),
not your account password.

Verify mail delivery before relying on it:

```bash
node dist/cli.js test-email
```

## Running it

**As a daemon** (has its own scheduler — nothing else needed):

```bash
npm start
```

**From system cron instead**, if you'd rather not keep a process alive:

```cron
30 8 * * 1-5  cd /path/to/nse-circular-tracker && /usr/bin/node dist/cli.js run >> run.log 2>&1
```

**Seed history** so the first real run doesn't email months of back-catalogue.
Backfill stores and classifies everything but suppresses all alerts:

```bash
node dist/cli.js backfill --days 180
```

## Commands

| Command | What it does |
|---|---|
| `start` | Scheduler daemon on `CRON_SCHEDULE` |
| `run [--days N]` | One fetch → classify → store → email cycle |
| `backfill --days N` | Import history without emailing (default 90) |
| `classify "<subject>"` | Show how the rules score a subject line — use this to tune |
| `list [--limit N]` | Recently stored circulars |
| `stats` | Counts by level, last run time |
| `test-email` | Verify SMTP and send a test message |

Add `MAIL_DRY_RUN=true` to any command to log the email instead of sending it.

## Importance classification

Two stages, because the feed is mostly noise and LLM calls cost money.

**Stage 1 — keyword rules** (`src/classify/rules.ts`). Each rule contributes its
weight at most once, so a downtime notice landing on a non-business day scores
higher than either alone. Negative rules exist because ~70% of MF circulars are
routine NFO launches; without them those drift upward on incidental matches.

| Tag | Weight | Example |
|---|---|---|
| `DOWNTIME` | +6 | "Downtime due to maintenance activity on NSE MF Invest Platform" |
| `SUSPENSION` | +5 | "Temporary Suspension of subscription in …" |
| `CUTOFF_CHANGE` | +5 | cut-off / timing revisions |
| `PENAL` | +5 | penalty, fraud, enforcement |
| `NON_BUSINESS_DAY` | +4 | "Non-Business Day for certain schemes …" |
| `MANDATORY` | +4 | "with immediate effect", "mandatory" |
| `MOCK_DR` | +4 | mock sessions, DR drills |
| `REGULATORY` | +3 | SEBI / AMFI / RBI directives |
| `RELEASE` | +3 | go-live, migration, API or file-format change |
| `SETTLEMENT` | +3 | settlement cycle, pay-in/pay-out |
| `ROUTINE_NFO` | **−3** | "Launch of X Fund NFO on NSE MF Invest Platform" |
| `ROUTINE_ADMIN` | **−2** | name changes, empanelment, sub-option intros |

Score ≥ `CRITICAL_THRESHOLD` (6) → **CRITICAL**; ≥ `IMPORTANT_THRESHOLD` (3) →
**IMPORTANT**; otherwise **ROUTINE**.

**Stage 2 — Claude fallback.** Only circulars scoring inside
`LLM_BAND_MIN`..`LLM_BAND_MAX` (default 0–2) go to the model. Score 0 means no
keyword matched at all, which in practice is the genuinely uncertain set —
"Merger of certain schemes of …", "Change in minimum amount under SIP". Clearly
negative scores are confidently routine and never reach the model.

Uses `claude-opus-5` at `effort: "low"` with a JSON schema via
`output_config.format`, so the verdict is always well-formed. **If the API call
fails or the model refuses, the deterministic rule verdict stands** — a
classifier outage can never stop circulars being recorded.

Leave `ANTHROPIC_API_KEY` empty to run on keyword rules alone. Everything still
works; you just lose the judgment call on the ambiguous band.

### Tuning

Test a subject line against the rules without touching the network or database:

```bash
$ node dist/cli.js classify "Downtime due to maintenance activity on NSE MF Invest Platform"
Level:   CRITICAL
Score:   6
Tags:    DOWNTIME
Reasons: Platform downtime or unavailability (+6)
```

If something important is being scored as routine, add a pattern to the relevant
rule in `src/classify/rules.ts` or lower `IMPORTANT_THRESHOLD`. Changing weights
does **not** retroactively reclassify stored circulars — delete
`data/circulars.db` and re-backfill if you want a clean re-score.

## Deduplication

`circDisplayNo` (e.g. `NSE/NMF/75630`) is the primary key. The dedup check runs
as a single `SELECT … IN (…)` *before* classification, so:

- re-running the same window is free and silent
- the overlapping lookback window is safe — a run that fires twice, or covers days
  an earlier run already saw, inserts nothing and emails nothing
- a missed day is picked up automatically by the next run

Alerts are deduplicated separately: `notified_at` is stamped only after the SMTP
server accepts the message, so a mail failure means the circular is retried in the
next digest rather than silently dropped.

## Data

SQLite at `DB_PATH` (default `./data/circulars.db`, gitignored):

- **`circulars`** — every field NSE returns, plus `importance_level`,
  `importance_score`, `importance_reasons`, `importance_tags`, `classifier`
  (`rules` or `llm`), `first_seen_at`, `notified_at`
- **`runs`** — one row per cycle with window, counts, and any error, for
  after-the-fact "did it run last Tuesday?" questions

## Things worth knowing

- **Classification reads the subject line only.** NSE's listing API doesn't expose
  the circular body, and the attachments are ZIPs of scanned PDFs. The email says
  as much — treat the level as triage, not a substitute for opening the circular.
- **NSE rate-limits and expires cookies aggressively.** The client retries with
  exponential backoff and a fresh session (`NSE_MAX_RETRIES`, default 4), and
  treats an HTML page served as HTTP 200 as a stale-cookie failure.
- **Other departments work too.** Set `NSE_DEPT` (`MF` is Mutual Fund) to track a
  different one; the scoring rules are MF-operations-specific and would want
  revisiting.
- **Flipping `NOTIFY_ON_ROUTINE=true` later** will email every routine circular
  stored so far in one digest, since none of them were ever marked notified.
