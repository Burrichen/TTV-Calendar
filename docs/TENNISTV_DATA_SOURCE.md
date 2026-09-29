# Tennis TV data source

How Tennis TV exposes its schedule and match state, what we verified, and what we
deliberately did not conclude.

**Captured:** 2026-09-14 (`npm run recon`, `npm run recon:semantics`)
**Access:** read-only, covered by the approval recorded in `PROJECT_SPEC.md` §2.
Nothing here bypasses authentication or any access control.

Everything in this document is **observed**. Where something is unverified it says so
explicitly, and the provider's safe default is stated alongside. Nothing is inferred
from Tennis TV's front-end source code alone without corroborating data.

---

## 1. How to reproduce this

```sh
npm run recon             # fetch, probe, capture, write sanitised fixtures
npm run recon:semantics   # analyse field meanings from .recon-out/raw
```

| Output | Contents |
| --- | --- |
| `.recon-out/recon-report.md` | endpoints, probes, field inventories, availability, lookahead table |
| `.recon-out/semantics.md` | identifier stability, time representation, status vocabulary, record shapes |
| `.recon-out/recon-report.json` | the same findings, machine-readable |
| `.recon-out/raw/` | unsanitised payloads, **gitignored**, for iterating without re-fetching |
| `test/fixtures/tennistv/` | sanitised, committed fixtures |

The harness lives in `scripts/recon/`. It sends an honest `User-Agent`, serialises
requests with a minimum 400 ms gap, sends no cookies or credentials, and drops
`set-cookie`/auth headers before anything reaches disk.

---

## 2. What was discovered

**`https://www.tennistv.com/tournaments` cannot usefully be scraped.** The page ships
an empty container:

```html
<section class="js-calendar body-wrapper widget" data-widget="tournaments/calendar-base"
         data-min-year="1990" data-max-year="2026" data-default-year="2026"></section>
```

The schedule is rendered client-side. A DOM scraper against that URL would extract
nothing, and a browser would be required purely to run the page's own JavaScript.

That JavaScript calls a **JSON API**. The harness extracts the API base URL and the
required header directly out of the site's entry bundle
(`/resources/v4.7.7/scripts/bundle-es.min.js`) rather than hard-coding what a human
once saw:

```
baseUrl: `${environment.tennisApi}/tennis/v1`
prepareHeaders: e => e.set("account-id", environment.accountId)
environment: { accountId: 35, tennisApi: "//api.tennistv.com", ... }
```

**Conclusion: a plain HTTP request to a structured JSON source works reliably, so
Playwright is not needed in production.** It is not needed for reconnaissance either —
the entire harness is `fetch`.

`robots.txt` is `User-agent: * / Disallow:` — nothing is disallowed.

---

## 3. Request shape

Base: `https://api.tennistv.com/tennis/v1`
Required header: `account-id: 35`

There are **no secrets involved**. No token, no cookie, no signature. The header is a
tenant selector that the public front end sends on every request. Nothing in this
document or in the fixtures carries credentials.

| Purpose | Request | Verified |
| --- | --- | --- |
| Tournaments in a date range | `GET /tournaments?from=YYYY-MM-DD&to=YYYY-MM-DD&size=250&page=0` | ✅ 81 rows for 2026-01-01 → 2027-03-31 |
| Tournament detail | `GET /tournaments/{id}/{year}` | ✅ |
| Matches for a tournament | `GET /matches?tournamentId={id}&year={year}` | ✅ 967 rows for the 2026 Australian Open |
| Order of play | `GET /oop` | ⚠️ returns `[]` — see §9 |

### Parameter behaviour (probed, not assumed)

- **`size` caps at 250.** `size=300` → `HTTP 400 {"message":"size: must be less than or
  equal to 250"}`. The provider must page.
- **`/tournaments` with no `from`/`to` ignores `year` and returns 20 rows starting at
  1877.** `?year=2026` returns the identical 5879-byte body as no parameters at all.
  `year` is not a filter on this endpoint — a trap worth knowing.
- **`/matches` requires `tournamentId` + `year`.** `/matches` alone, `?date=`,
  `?status=L` and `?status=U` all returned `{"tournaments":[],"matches":[]}`.
  `?tournamentId=&year=&date=` returns the same as without `date` — `date` is ignored.
- `page` works; a page beyond the result set returns `[]`.

### Endpoints the bot must never call

The bundle also references `/entitlementcheck/v1/videoentitlements`, `/favoritemedia/…`
and `/content/…`. These are user-account and video-entitlement endpoints. They are
outside the scope of this project, they would require authentication, and the provider
must not touch them.

---

## 4. Response shape

### Tournament

```json
{
  "id": 4713,
  "year": 2026,
  "name": "Hangzhou",
  "gender": "ATP",
  "start": "2026-09-23",
  "qualificationStart": "2026-09-22",
  "end": "2026-09-29",
  "type": "250",
  "location": "China",
  "surface": "Hard",
  "info": { "title": "Hangzhou Open", "city": "Hangzhou", "utcOffset": 8, "mainStart": "2026-09-23", "inOutdoor": "O" },
  "metadata": { "customRoute": "/tournaments/hangzhou-open", "matchesSize": "23" }
}
```

Field presence across the 81 tournaments captured:

| Field | Present | Notes |
| --- | --- | --- |
| `id`, `year`, `name`, `start`, `end`, `type`, `gender`, `surface` | 81/81 | always present |
| `location` | 80/81 | **can be missing** |
| `info.city` | 80/81 | |
| `info.utcOffset` | 80/81 | **can be missing** — decimal hours, e.g. `8`, `-4`, `5.5` |
| `qualificationStart` | 77/81 | |
| `metadata` | 61/81 | **absent entirely for 20 tournaments** |
| `metadata.customRoute` | 61/81 | path on tennistv.com; verified to resolve (HTTP 200) |
| `metadata.matchesSize` | 56/81 | an *expected* match count — **not** published matches (see §7) |
| `metadata.notShown` | 6/81 | 5 × `true`, 1 × `false` |
| `metadata.broadcastText` | 5/81 | always `"Not Shown On Tennis TV"` |
| `availableOopDays` | 47/81 | present only once an order of play exists |

### Match

Two different record shapes arrive in the same `matches` array, distinguished by
`PulseStatus`:

| | `PulseStatus: "C"` — result record | `PulseStatus: "U"` — order-of-play record |
| --- | --- | --- |
| Count in sample | 1436 | 432 |
| Competitors | `PlayerTeam1` / `PlayerTeam2` | `TeamsInMatch[2]`, each with `Players[]` and `IsKnown` |
| Start time | concrete `MatchDate` time-of-day | `MatchDate` at `T00:00:00` + `NotBeforeISOTime` / `NotBeforeText` |
| Unique to it | `ResultString`, `WinningPlayerId`, `Reason`, `MatchTime`, `Serve` | `NotBeforeISOTime`, `NotBeforeText`, `IsNightSession`, `TeamsInMatch`, `RoundId` |

A provider must handle **both** shapes. Fields present on all 1868 sampled matches:
`MatchId`, `MatchDate`, `PulseStatus`, `CourtName`, `TournamentId`, `TournamentYear`,
`AssociationCode`. `Status` is present on 1867/1868 — **it can be absent**, and was,
on one United Cup order-of-play record.

### What the bot needs, and whether it is available

| Required | Available | Source |
| --- | --- | --- |
| Tournament ID | ✅ | `id` (+ `year`, see §5) |
| Tournament name | ✅ | `name`; `info.title` is the sponsored long form |
| Tournament location | ✅ (80/81) | `location` (country) + `info.city` |
| Tournament start/end | ✅ | `start`, `end`, plus `qualificationStart` |
| Shown on Tennis TV | ✅ | `metadata.notShown` — see §8 |
| Match/event ID | ✅ | `MatchId`, **but see §5 — not globally unique** |
| Competitors | ✅ | `PlayerTeam1`/`PlayerTeam2` or `TeamsInMatch[].Players[]` |
| Scheduled start time | ⚠️ partial | `MatchDate` / `NotBeforeISOTime` — see §6 |
| Live state | ⚠️ **unverified** | `PulseStatus: "L"` declared by the front end, never observed — see §9 |
| Delayed state | ⚠️ **unverified** | no delayed record observed — see §9 |
| Cancelled state | ✅ | `Status: "CA"` (27 observed) |
| Completed state | ✅ | `Status: "F"` or `"Finished"` |
| Round | ✅ | `Round.ShortName` / `LongName` / `RoundName` |
| Court | ✅ | `CourtName` (all sampled), `CourtId`, `CourtSeq` |
| Source/tournament URL | ✅ | `https://www.tennistv.com` + `metadata.customRoute` |
| Last-updated info | ❌ **not available** | see §10 |

---

## 5. Stable identifiers

**`MatchId` is not globally unique.** Across 1868 sampled matches there are 1865
distinct values — `MS011`, `MS021` and `MS031` each appear in more than one
tournament. Observed `MatchId` shapes:

```
MSSR73997584   QSSR71557862   WDSR…   XDSR…      (Sportradar-derived, long)
sr:sport_event:67662966                          (Sportradar URN)
MS021  LS014  MX013  CD002                       (short codes — the colliding ones)
```

**Match identity must therefore be `(TournamentId, TournamentYear, MatchId)`**, which
is unique across all 1868 records. Tournament identity is `(id, year)` — `id` alone
repeats every year (Wimbledon is `540` in 1877 and in 2026).

This matters beyond tidiness: the prompt's rule against keying identity on scheduled
start time is right, and `MatchId` alone would have been the other obvious wrong
answer.

`PlayerId` also comes in two formats — short codes (`B0NN`, `H996`) and Sportradar
URNs (`sr:competitor:466689`) — sometimes within the same tournament. Player identity
is not needed by this bot, which only renders names, so this is recorded rather than
solved.

---

## 6. Time representation

`MatchDate` is a **naive local timestamp with no zone**: `"2026-08-24T11:00:00"`. It
is venue wall-clock time. There is no UTC anywhere in the match payload.

Conversion to UTC uses `tournament.info.utcOffset` (decimal hours, e.g. `-4`, `8`,
`5.5`) — an offset **supplied by the source for that tournament**, which satisfies
`PROJECT_SPEC.md` §7's rule against hard-coding one. `utcOffset` is missing on 1 of 81
tournaments, so the provider must treat a missing offset as *time unknown* rather than
assume anything.

### Published time vs unpublished time

The cross-tabulation over 1868 matches:

```
has-time | no-NotBeforeISO | no-NotBeforeText   1434
no-time  | NotBeforeISO    | no-NotBeforeText    333
no-time  | no-NotBeforeISO | "Followed By"        56
no-time  | NotBeforeISO    | "Starts At"          22
no-time  | NotBeforeISO    | "Not Before"         21
no-time  | no-NotBeforeISO | no-NotBeforeText      2
```

Two clean rules fall out, both verified by test:

1. **`MatchDate` at `T00:00:00` means the start time is not published.** The *date* is
   still known. 434 of 1868 records are in this state.
2. **A published time and a NotBefore time are mutually exclusive.** Zero records
   carry both.

`NotBeforeISOTime` is a **time-of-day with its own explicit offset and no date**:
`"10:00+0800"`, `"13:25+1100"`. Where it exists it is more precise than
`info.utcOffset`, and it is the better source.

`NotBeforeText` qualifies what that time means:

| Value | Count | Meaning | Bot behaviour |
| --- | --- | --- | --- |
| `"Starts At"` | 22 | a scheduled start | usable as a start time |
| `"Not Before"` | 21 | earliest possible start | **`Time TBC`** |
| `"Followed By"` | 56 | follows the previous match on that court | **`Time TBC`** |
| absent (with `NotBeforeISOTime`) | 333 | unqualified | **`Time TBC`** — ambiguous, do not guess |

Per `PROJECT_SPEC.md` §8 the bot never guesses. Only `"Starts At"` is treated as a
real start time; everything else in the `no-time` group renders as `Time TBC`, with
the "not before" time available as supporting context if we choose to show it.

---

## 7. Schedule granularity — tournaments far ahead, matches only near the day

**This is the most important finding, and it contradicts an assumption in the original
architecture.**

Match-level data does not exist ahead of a tournament. Not "matches with unknown
times" — **no match records at all**:

| Tournament | Starts | Days out | `availableOopDays` | Matches returned |
| --- | --- | --- | --- | --- |
| United Cup 2026 | 2026-01-02 | −255 | 10 | **168** |
| Brisbane 2026 | 2026-01-04 | −253 | 9 | **96** |
| Australian Open 2026 | 2026-01-18 | −239 | 19 | **967** |
| French Open 2026 | 2026-05-24 | −113 | 20 | **637** |
| **Hangzhou** | 2026-09-23 | **+9** | none | **0** |
| **Chengdu** | 2026-09-23 | **+9** | none | **0** |
| **Tokyo** | 2026-09-30 | **+16** | none | **0** |
| **Beijing** | 2026-09-30 | **+16** | none | **0** |
| **Nitto ATP Finals** | 2026-11-15 | **+62** | none | **0** |
| **United Cup 2027** | 2027-01-01 | **+109** | none | **0** |

So, to answer the question directly:

> **Are monthly match-level times published that far ahead? No.** Nine days before a
> tournament starts, Tennis TV publishes the *tournament* — id, name, location, dates,
> surface, expected size — and **no matches whatsoever**.

`metadata.matchesSize` (`"23"` for Hangzhou) is a *forecast* of how many matches the
event will have. It is not a count of published matches and must never be read as one.

`availableOopDays` appears only once an order of play is published: 47 of 81
tournaments have it, and they are exactly the tournaments that have already happened.
**`availableOopDays` is therefore the signal that match-level data exists.**

### The distinction the bot must model

| | Tournament level | Match level |
| --- | --- | --- |
| Available | months ahead | only once the draw/OOP is published |
| Carries | name, location, dates, surface, shown-on-TTV | competitors, court, round, start time, state |
| Feeds | monthly and weekly summaries | daily summaries and live alerts |

Consequences:

- The **monthly** summary is necessarily a *tournament* schedule. Match-level times
  will essentially never be available a month ahead. `PROJECT_SPEC.md` §4.3's "include
  dates and UK-local start times where known" already accommodates this — "where
  known" will usually mean "not known", and the summary lists tournaments with their
  date ranges.
- The **weekly** summary is mostly tournament-level, possibly with match detail for
  events already under way.
- The **daily** summary is the only one that can reliably be match-level, and only for
  tournaments that are in progress or starting that day.

### The open operational question

We have measured that 9 days out is too early. We have **not** measured how many days
before a tournament the matches appear, because no tournament in the sample was within
9 days of starting at capture time.

This matters for the daily summary: if an order of play for day 1 is not published
until, say, 20:00 UK the night before, the 08:00 daily post on day 1 will see it, but
a tournament starting overnight in Asia could be marginal.

**It is measurable with the harness already built.** Hangzhou and Chengdu start
2026-09-23. Running `npm run recon` once a day from now until then records exactly when
match records appear. That is one command, and its output is a dated report.

---

## 8. "Not shown on Tennis TV"

Availability is marked **on the tournament**, not the match:

```json
"metadata": { "notShown": true, "broadcastText": "Not Shown On Tennis TV",
              "customRoute": "/tournaments/us-open-tennis" }
```

All five examples found in 2026:

| Start | Tournament | Type | `broadcastText` |
| --- | --- | --- | --- |
| 2026-01-18 | Australian Open | GS | Not Shown On Tennis TV |
| 2026-05-24 | French Open | GS | Not Shown On Tennis TV |
| 2026-06-29 | Wimbledon | GS | Not Shown On Tennis TV |
| 2026-08-30 | US Open | GS | Not Shown On Tennis TV |
| 2026-09-25 | Laver Cup | LVR | Not Shown On Tennis TV |

That is the four Grand Slams and the Laver Cup — which matches Tennis TV's public
proposition (ATP Tour events, not the Slams).

**The marker is sparse and its absence is meaningful.** Only 6 of 81 tournaments carry
`notShown` at all (5 `true`, 1 explicit `false`), and 20 tournaments have no
`metadata` object whatsoever. The rule in `PROJECT_SPEC.md` §9 — *exclude what is
explicitly marked unavailable, do not require a positive marker* — is therefore
correct and is the only rule that works against this data.

**No match-level `notShown` was observed** in 1868 matches. A match-level `metadata`
object does exist (131 of 1868) but carries editorial copy (`description`), not
availability. The provider will still honour a match-level marker if one ever appears,
falling back to the tournament's.

---

## 9. Status values

Observed across 1868 matches from four completed tournaments:

| `Status` | Count | Meaning | Domain state |
| --- | --- | --- | --- |
| `F` | 1400 | finished (result record) | `finished` |
| `Finished` | 431 | finished (order-of-play record) | `finished` |
| `CA` | 27 | cancelled | `cancelled` |
| `WO` | 9 | walkover (always with `Reason: "W/O"`) | `cancelled` |
| *absent* | 1 | order-of-play record with no status | `scheduled` |

| `PulseStatus` | Count | Meaning |
| --- | --- | --- |
| `C` | 1436 | completed / result representation |
| `U` | 432 | upcoming / order-of-play representation |

`Reason` appears on 43 records: `RET` ×34 (retired, always with `Status: "F"`) and
`W/O` ×9 (always with `Status: "WO"`).

### Two cautions

**`Status` and `PulseStatus` can disagree.** 431 records carry `Status: "Finished"`
with `PulseStatus: "U"`. These are order-of-play rows for matches that have since been
played; the OOP representation kept `PulseStatus: "U"` while `Status` moved on.
**`Status` is the truthful field; `PulseStatus` indicates which representation the
record is, not whether the match has happened.** The front end agrees — its own live
filter is `Status !== "F" && Status !== "Finished"`.

**The front-end constant table is not the API's vocabulary.** The bundle declares
single-character codes:

```
UPCOMING:"U" ON_COURT:"C" WARMUP:"W" PLAYING:"P" SUSPENDED:"S" TOILET_BREAK:"D"
MEDICAL_TIMEOUT:"M" CHALLENGE_IN_PROG:"R" CORRECTION_MODE:"E" FINISHED:"F" CANCELLED:"L"
```

But the API returned `CA` and `WO`, which that table does not contain, and never
returned `L` for a cancellation. **The declared table is documentation of intent, not
of data.** The status mapping must be built from observation and must treat unknown
codes defensively.

### What we did NOT observe

No tournament was in progress on 2026-09-14 — the US Open ended on the 13th and
Hangzhou/Chengdu start on the 23rd. Consequently:

- **No live match was observed.** `PulseStatus: "L"` and the in-play `Status` codes
  (`C`, `W`, `P`, `D`, `M`, `R`, `E`) are declared by the front end and are plausible,
  but **unverified against data**.
- **No delayed or suspended match was observed.** `Status: "S"` is unverified, and we
  do not know whether a rain delay instead appears as a moved `MatchDate`, a new
  `NotBeforeISOTime`, or a `NotBeforeText` change.
- **`/oop` was never seen populated.** It returned `[]` for every parameter
  combination tried, on a day with no play. Its populated shape is unknown.

These are recorded as unknowns rather than filled in with guesses. The provider's
behaviour for each is specified in §11.

---

## 10. Freshness and last-updated information

**There is none.** The API returns no `Last-Modified`, no `ETag`, no `Cache-Control`
and no `Age`:

```
HTTP/2 200
content-type: application/json
date: Mon, 14 Sep 2026 09:18:57 GMT
vary: Origin
x-cache: Miss from cloudfront
```

No payload field carries an update timestamp either — no `updatedAt`, `modified` or
`lastUpdated` appears on any tournament or match record.

Consequences:

- Conditional requests are impossible; every poll is a full fetch.
- The bot cannot ask "has anything changed?" — it must diff against its own stored
  state, which `ARCHITECTURE.md` §9 already requires.
- "Last updated" cannot be shown to users, and must not be fabricated from our own
  fetch time and presented as Tennis TV's.

Responses are served through CloudFront, so some caching exists between us and the
origin, with no documented TTL.

---

## 11. Fallback behaviour

How the provider behaves when the source is unhelpful. Each is a deliberate choice
that prefers silence over a wrong statement.

| Situation | Behaviour |
| --- | --- |
| Non-2xx, timeout, or malformed JSON | Retry with capped exponential backoff + jitter. **Never** mutate stored match state. A failed poll is "not observed", never "cancelled". |
| Schema validation fails | Reject the payload, log at `error` with the failing path, keep the previous state. A shape change must be loud, not silently absorbed. |
| `matches` empty for an in-progress tournament | Treat as "no data yet", not "no matches". Never delete stored matches on an empty read. |
| Tournament has no `availableOopDays` | Tournament-level only. Emit the tournament; emit no matches; do not infer any. |
| `info.utcOffset` missing | Start time is **unknown**. Render `Time TBC`. Do not guess an offset. |
| `MatchDate` at `T00:00:00` | Start time unpublished → `Time TBC`, date still used for day bucketing. |
| `NotBeforeText` is `"Not Before"` / `"Followed By"` / absent | `Time TBC`. Only `"Starts At"` is a real start time. |
| `Status` absent | Fall back to `PulseStatus`; `U` → `scheduled`. |
| Unrecognised `Status` code | Map to `unknown`, log at `warn`, **emit no transition**. An unfamiliar code must never look like a cancellation. |
| `metadata` absent on a tournament | Shown on Tennis TV. Absence of the marker is not absence of availability. |
| `/oop` empty or unavailable | Drive everything from `/matches?tournamentId&year`, which is verified. `/oop` is not on the critical path. |

---

## 12. Known limitations

1. **No live, delayed or suspended state has been observed.** The single largest gap.
   Resolvable from 2026-09-23 when Hangzhou and Chengdu start.
2. **How far ahead match data appears is unmeasured** beyond "more than 9 days is too
   early" (§7).
3. **`/oop` shape is unknown.** Never seen populated.
4. **The status vocabulary is incomplete by construction** — it was sampled from four
   completed tournaments, so it can only contain terminal states.
5. **No documented contract or rate limit.** The endpoints are what the public site
   uses; there is no published API specification and no versioning guarantee beyond
   the `/tennis/v1` path segment. The `account-id` value and bundle path
   (`v4.7.7`) can change with a site release — the harness re-derives both, so a
   release moves the bundle without breaking discovery.
6. **Sample is four tournaments**, chosen to span phases and availability, not the
   whole season. Re-running the harness widens it.
7. **Qualifying, doubles and joint (WTA-inclusive) events are all present** in the
   feed. Whether QA wants them in summaries is a product decision, not a data one.
8. **Editorial `metadata.description`** exists on some matches. It is marketing copy;
   the bot has no use for it.

---

## 13. Isolation of this dependency

Per `ARCHITECTURE.md` §15, every fact in this document is knowledge of an **internal
endpoint used by Tennis TV's own front end**, and all of it is confined to:

```
src/tennistv/http-provider.ts    URLs, the account-id header, paging
src/tennistv/schemas.ts          Zod schemas for the raw payloads
src/tennistv/mapper.ts           raw → domain: time, TBC, availability, state
scripts/recon/                   this reconnaissance harness
test/fixtures/tennistv/          sanitised captures
```

No other module may reference `api.tennistv.com`, `account-id`, `MatchId`,
`PulseStatus`, `notShown`, `NotBeforeISOTime`, or any other name in this document. An
import-graph test enforces it.

**If Tennis TV changes:** re-run `npm run recon`, and
`test/tennistv-source.contract.test.ts` will fail on whichever documented belief no
longer holds — before any of it can reach a Slack message.

---

## 14. Confirmed during implementation (2026-09-14)

Building the provider re-verified every claim above against the live API and added
three practical details that only surface once you write the client.

**The `size` cap is enforced, not advisory.** `size=300` returns
`HTTP 400 {"error":"Bad Request","message":"size: must be less than or equal to 250"}`.
The provider pages at 250 and treats a short page as the last one. The live contract
test asserts the cap still behaves this way, because a *tightened* cap would silently
truncate the schedule.

**`/matches` carries its own tournament, and that is where the venue offset lives.**
The envelope is `{ tournaments: [...], matches: [...] }`, and the tournament entry
supplies `info.utcOffset` and the availability marker. The provider maps matches
*through* that entry. When the envelope arrives without a usable tournament, start
times are reported as `Time TBC` with reason `NO_VENUE_OFFSET` and a warning is
logged — the one thing it must never do is assume an offset.

**No response carries cache validators.** Confirmed again across every endpoint: no
`ETag`, no `Last-Modified`, no `Cache-Control`. Conditional requests are impossible,
so the provider caches on time-to-live alone — one hour for tournaments, ten minutes
for match schedules, and **never** for live state.

### Status vocabulary: the unverified half is now explicit

The provider maps the in-play codes (`C`, `W`, `P`, `D`, `M`, `R`, `E`) to `LIVE` and
`S` to `DELAYED`, even though none was observed. The alternative — mapping them to
`UNKNOWN` — would suppress the live alerts the bot exists to send.

That optimism is recorded rather than hidden: every match mapped from an unverified
code carries `rawStatus.unmapped = true`, the raw code is stored alongside the
normalised status, and `findUnmappedStatuses()` reports what is accumulating. The first
live tournament will tell us whether the guesses were right, and the data to check will
already be in the database.

### Still not observed

Nothing has changed here: no live match, no delayed match, no populated `/oop`, and no
measurement of how many days before a tournament its matches appear. §12 stands.

The live contract test (`npm run test:contract`) is the mechanism that will notice when
any of it changes.

---

## 14. Fixtures

`test/fixtures/tennistv/`, regenerated by `npm run recon`:

| Fixture | Represents |
| --- | --- |
| `tournaments-season.json` | 81 tournaments, 2026-01-01 → 2027-03-31, including all five not-shown events |
| `matches-580-2026.json` | Australian Open — both record shapes, unpublished times, `NotBeforeISOTime` |
| `matches-520-2026.json` | French Open — `Status: "CA"` cancellations and `WO` walkovers |
| `matches-9900-2026.json` | United Cup — mixed doubles, `TeamsInMatch`, the record with no `Status` |
| `matches-339-2026.json` | Brisbane — a small ordinary ATP 250 |
| `matches-4713-2026.json`, `matches-7581-2026.json` | Hangzhou, Chengdu — **empty**, the "draw not published" case |

Samples are stratified by `Status × PulseStatus × Reason × time-shape × NotBeforeText`,
so rare-but-important records survive while a 967-match Grand Slam does not land in git.

Sanitisation (`scripts/recon/lib/sanitise.ts`) removes, recursively: credentials and
session fields; signed/entitlement media URLs (`onDemandUrl`); personal detail for
players and named officials (`BirthDate`, `BirthCity`, `Age`, `Umpire*`, `Official*`);
player earnings (`winners`, `careerPrize`, `ytdPrize`); and third-party or commercial
identifiers we have no use for (`srSeasonIds`, `tdiId`, `prize`, `commitment`).

`test/fixtures.safety.test.ts` re-checks every committed fixture for denied keys and
secret-shaped strings, so a future re-capture cannot quietly reintroduce any of it.
