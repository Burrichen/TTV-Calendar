# Cloudflare Workers compatibility assessment

> **Status: historical, and still accurate.**
>
> This assessment was made while an all-Cloudflare production architecture was being
> explored. That architecture was **abandoned** — see
> [`ARCHITECTURE.md` §17](ARCHITECTURE.md#17-architecture-history). The Node application
> on GitHub Actions is the production runtime; Cloudflare handles Slack button clicks
> and holds state in D1.
>
> The findings below are kept because they remain true and are still load-bearing: they
> are the evidence that **Tennis TV needs no browser**, which is why no Playwright or
> Chromium dependency exists in this project in any runtime. Only §2's conclusion about
> which architecture to adopt was overtaken.

**Question:** can the production Tennis TV retrieval path run inside a Cloudflare
Worker, or does it need a real browser?

**Answer: yes, it runs in a Worker unchanged. Category A — plain HTTP/`fetch` against a
public JSON API. No browser, no Playwright, no Chromium, at any point.**

This document records how that was established, so the conclusion can be re-checked
rather than taken on trust.

---

## 1. How the conclusion was reached

The assessment was made by reading the implementation, not by assuming.

### 1.1 There is no browser anywhere in the project

```
$ grep -ri "playwright\|puppeteer\|chromium\|webdriver\|selenium" package.json src/ scripts/
(no matches)
```

`package.json` lists seven runtime dependencies: `@slack/bolt`, `croner`, `kysely`,
`luxon`, `pg`, `pino`, `zod`. None is a browser automation library.

This is not an accident. `docs/TENNISTV_DATA_SOURCE.md` records the outcome of the
reconnaissance phase: Tennis TV's own front end is served by a public JSON API, and
reconnaissance deliberately established that the data could be read from that API
directly rather than by rendering and scraping the page. The provider was written
against that finding from the start. There is no DOM parsing to port.

### 1.2 The retrieval path uses only web-standard APIs

`src/tennistv/http-client.ts` is the entire network layer — every request to Tennis TV
goes through its `getJson()`. Its complete runtime surface:

| API used | Available in workerd? |
| --- | --- |
| `fetch(url, { method, headers, redirect, signal })` | Yes — the Workers runtime is built around it |
| `Response` (`.ok`, `.status`, `.headers.get`, `.text()`) | Yes |
| `AbortSignal.timeout(ms)` | Yes |
| `DOMException` (`TimeoutError` / `AbortError` names) | Yes |
| `performance.now()` | Yes |
| `setTimeout` (retry backoff) | Yes |
| `JSON.parse`, `Date`, `Math.random` | Yes (ECMAScript) |

There is no `node:http`, no `https.Agent`, no socket handling, no streaming beyond
`response.text()`, and no filesystem access. The client would run unmodified in a
browser.

### 1.3 The layers above it are pure computation

| Module | Depends on | Worker-safe |
| --- | --- | --- |
| `src/tennistv/http-provider.ts` | http-client, schemas, mapper | Yes |
| `src/tennistv/schemas.ts` | `zod` | Yes — pure JS, no Node built-ins |
| `src/tennistv/mapper.ts` | `luxon` | Yes — pure JS, ships its own tz data via `Intl` |
| `src/tennistv/status-map.ts`, `errors.ts`, `cache.ts`, `endpoints.ts` | nothing | Yes |
| `src/domain/*` | `luxon` | Yes |
| `src/slack/blocks/*` | `@slack/types` (types only) | Yes |
| `src/schedule/occurrences.ts` | `luxon` | Yes |

Luxon deserves a specific note, because time handling is a stated requirement:
`Europe/London` reasoning is done through `Intl.DateTimeFormat`'s IANA time zone
database, which `workerd` implements. BST/GMT therefore continues to be resolved by the
platform, and no offset is hard-coded anywhere — the same guarantee the Node build had.

### 1.4 The three modules that are *not* Worker-safe are not on the production path

```
$ grep -rn "from 'node:" src/
src/health/server.ts:9         node:http          — removed (see below)
src/tennistv/index.ts:8        node:path          — fixture directory only
src/db/migrate.ts:10-12        node:fs, node:path — removed with PostgreSQL
src/tennistv/fixture-provider.ts:13-14  node:fs, node:path — tests and local dev only
```

- `fixture-provider.ts` reads captured JSON fixtures from disk. It is a test and local
  development aid and is never selected in production (`TENNISTV_PROVIDER=live`). It
  stays in the repository and stays out of the Worker bundle.
- `src/tennistv/index.ts` is only a factory that chooses between the two providers, and
  its single Node import exists to locate that fixture directory. The Worker constructs
  `HttpTennisTvProvider` directly and never imports this factory, so `node:path` never
  enters the bundle.
- `src/health/server.ts` and `src/db/migrate.ts` belong to the architecture being
  replaced.

### 1.5 Logging was the one genuine incompatibility, and it was small

`pino` targets Node streams and is not appropriate inside a Worker. The provider only
ever consumed a *structural* logger — `child()` plus levelled methods — so the type was
extracted to `src/logging/types.ts` and the Worker supplies a small `console`-backed
implementation that emits the same JSON shape into Cloudflare's log stream. `pino`
remains the Node implementation. No provider code changed.

This split was kept after the architecture changed. The Worker still logs, still cannot
use `pino`, and the structural type is the right way to express that — it is a better
seam than the concrete dependency it replaced.

---

## 2. Consequences for the architecture

**What this finding settled, permanently:**

- **No browser is required to read Tennis TV.** Not in a Worker, not on a GitHub Actions
  runner, not anywhere. This is why the project has no Playwright, Puppeteer or Chromium
  dependency, and why a run costs seconds rather than the minutes a browser install
  would add.
- The `TennisTvProvider` abstraction, its schema validation, its retry/backoff policy
  and its error taxonomy needed **no changes at all**. Nothing about parsing semantics
  was altered to obtain compatibility, which was an explicit constraint — and since the
  provider now runs on Node again, nothing had to be undone either.

**What this finding did *not* settle** — and what was subsequently decided differently:

- At the time, this was read as "therefore use the all-Cloudflare architecture", with
  the Worker running everything on a 20-minute Cron Trigger. That conclusion was
  reversed. *Can* it run in a Worker and *should* it are different questions;
  feasibility was never the objection. See
  [`ARCHITECTURE.md` §17.2](ARCHITECTURE.md#17-architecture-history).
- GitHub Actions is now the production runner, not merely the CI platform.

## 3. What would invalidate this

This conclusion depends on Tennis TV continuing to serve the JSON API documented in
`docs/TENNISTV_DATA_SOURCE.md`. If that API were withdrawn and the data became available
only to a rendered page, the provider would need browser execution.

Under the current architecture that is survivable: the Node application runs on a GitHub
Actions runner, which can install and drive a browser if it ever genuinely has to. The
`TennisTvProvider` interface is the seam that would contain such a change, leaving the
Slack and persistence layers untouched. It is worth noting that this would have been a
much harder problem under the all-Cloudflare architecture, where no Worker could have
run it at all.

`npm run test:contract` is the early-warning system: it exercises the real endpoints and
fails with a diagnostic naming what changed.
