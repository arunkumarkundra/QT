# Waypoint

**[waypoint.holiday](https://waypoint.holiday)** — your next trip, figured out.

Most travel sites ask where you want to go. Waypoint asks when you are free.
It reads the public holiday calendar for where you live, works out which
breaks you could actually take and how much leave each would cost, then
suggests destinations that fit the time, the season, the budget and the
kind of trip you want.

A full explanation of the method is at
[waypoint.holiday/how-it-works.html](https://waypoint.holiday/how-it-works.html).

---

## How it is put together

One Cloudflare Worker, named `waypoint`, serves both halves from the same
address, and is deployed automatically from this repository.

| Piece | Address | What it is |
|---|---|---|
| **The site** | `waypoint.holiday/…` | Static files. No build step, no framework, no bundler. |
| **The API** | `waypoint.holiday/api/…` | `worker.js`. |

Existing files are served straight from Cloudflare's static asset store and
never run any code, so page views do not count towards the Workers daily
request limit. Only `/api/` requests (and requests for files that do not
exist) run `worker.js`.

There is no build. What is in this repository is what is served. That is
deliberate: it means a change can be made and shipped from the GitHub web
editor, and there is no toolchain to rot.

The browser never talks to a third-party API for anything essential. The
Worker sits in front, caches aggressively, and holds every credential.

---

## What is in the repository

### The site

| File | What it does |
|---|---|
| `index.html` | The entire application — markup, styles and shell logic in one file |
| `waypoint-engine.js` | The decision engine: scoring, ranking, simulation |
| `waypoint-data.js` | The atlas: 490 destinations across 130 countries, plus the climate model |
| `waypoint-config.js` | Tunable constants and scoring weights |
| `waypoint-climate.js` | Climate normals |
| `waypoint-costs.js`, `waypoint-prices.js` | Cost-of-living and price reference data |
| `waypoint-holidays.js` | Public holiday logic, including regional calendars |
| `waypoint-festivals.js` | Festivals and events |
| `waypoint-notes.js` | Written destination notes |
| `waypoint-popularity.js` | Popularity signals |
| `waypoint-photos.js` | Photo manifests and credits |
| `waypoint-airports.js` | Airports and route networks |
| `waypoint-heritage.js` | UNESCO and heritage listings |
| `waypoint-reputation.js` | Reputation signals |
| `waypoint-nearby.js` | Nearby-place logic |
| `waypoint-pdf.js`, `waypoint-pdf-bridge.js` | PDF export |
| `hero-images.json` | The rotating homepage photograph |

### Standalone pages

| File | What it is |
|---|---|
| `how-it-works.html` | The method, explained in public |
| `privacy.html` | Privacy policy |
| `terms.html` | Terms of use |
| `contact.html` | Contact, with the address assembled in the browser so crawlers cannot harvest it |
| `404.html` | Not-found page |
| `sources.html` | Data and sources, in detail |
| `legal.css` | Shared styling for all of the above |

### The API

`worker.js` — the Worker. Not published as a file (see `.assetsignore`). Endpoints:

| Endpoint | Cost | What it does |
|---|---|---|
| `/api/health` | free | Liveness check |
| `/api/where` | free | Approximate location from Cloudflare's own geolocation |
| `/api/holidays` | free | Public holidays, cached |
| `/api/climate` | free | Climate normals and forecast |
| `/api/fx`, `/api/prices` | free | Exchange rates and cost reference |
| `/api/nearby`, `/api/geocode`, `/api/fares` | free | Places, geocoding, fare estimates |
| `/api/photo` | free | Photo lookup with credit |
| `/api/live` | free | Air quality, hazards, advisories |
| `/api/ready-link` | free | Outbound partner link router |
| `/api/brief` | **metered** | AI destination briefing |
| `/api/parse` | **metered** | AI parsing of free-text input |

Only the last two use AI, and both are rate-limited: a few calls a minute
per visitor (Cloudflare's rate limiter), a daily cap per visitor (KV), and
a soft daily ceiling for the whole site. On the Workers Free plan, Workers
AI stops at its free daily allowance and cannot bill. If
`ANTHROPIC_API_KEY` is ever set, also set a monthly spend limit in the
Anthropic console.

### Internal tools

These are deployed but deliberately kept out of search results by an
`X-Robots-Tag` header set in `_headers`. They are workbenches for
maintaining the data, not part of the product.

`atlas-studio.html`, `photo-studio.html`, `score.html`, `coverage.html`,
`build-airports.html`, `build-costs.html`, `build-popularity.html`,
`tools/build-climate.html`, `annotator/`, `golden/`

### Configuration

| File | What it controls |
|---|---|
| `wrangler.jsonc` | The Cloudflare Worker: name, domains, bindings (AI, KV, rate limiter), and how files and `/api/` are routed |
| `_headers` | Security headers, cache headers, and the noindex rules for the tools above |
| `.assetsignore` | Files in this repository that must **not** be published (the Worker source, config, scripts, `.git`). **Add any new private file here.** |
| `robots.txt` | Crawler policy. AI training crawlers are currently allowed; there is a commented-out block to refuse them |
| `sitemap.xml` | The public pages, written without `.html`. **Add an entry here whenever a new public page is created.** |
| `site.webmanifest` | Install metadata, icons and screenshots |

---

## Deploying

Push to `main`. Cloudflare Workers Builds deploys the site and the API
together, usually within a minute. Progress and errors are under
Workers & Pages → `waypoint` → Deployments.

Do **not** edit `worker.js` in the Cloudflare dashboard editor. The next
push to `main` replaces whatever was pasted there.

### Addresses and pages

Pages are served at short addresses: `/how-it-works`, not
`/how-it-works.html`. The `.html` form still works; it redirects. A file
that does not exist gets `404.html` with a real 404 status. These are set
by `html_handling` and `not_found_handling` in `wrangler.jsonc`.

### Test addresses

`waypoint.arunkumarkundra.workers.dev` always serves the latest deploy.
Each deploy also gets its own preview address, listed under Deployments.
Both are kept out of search engines by `_headers`.

---

## Worker settings

Set these in the Cloudflare dashboard under
Workers & Pages → `waypoint` → Settings → Variables and Secrets.
Use that screen, not "Build variables", which the running Worker cannot
see. Deploys from GitHub leave these untouched.
None are required; each one switches on a capability when present.

| Name | Effect if set |
|---|---|
| `RATE_SALT` | **Recommended.** Salts the one-way fingerprint used by the rate limiter, so the stored values cannot be reversed back to IP addresses. |
| `FIRMS_MAP_KEY` | NASA FIRMS wildfire data in `/api/live` |
| `TRAVELPAYOUTS_TOKEN` | Cached fare estimates in `/api/fares` |
| `ANTHROPIC_API_KEY` | Uses Claude for destination briefings instead of Workers AI. Better output, a fraction of a cent each. |
| `SKYSCANNER_MEDIA_PARTNER_ID`, `SKYSCANNER_SUBID2` | Skyscanner attribution |
| `BOOKING_AID`, `BOOKING_LABEL` | Booking.com attribution |
| `VIATOR_PID`, `VIATOR_MCID`, `VIATOR_CAMPAIGN` | Viator attribution |
| `DISCOVER_CARS_AFFILIATE_URL` | URL template; `{destination}` is substituted |
| `TOURRADAR_DEEPLINK`, `AIRALO_DEEPLINK`, `ROME2RIO_DEEPLINK`, `KAYAK_DEEPLINK`, `WISE_DEEPLINK` | URL templates containing `{url}` |

### Network links for Skyscanner, Booking.com and Viator

These three take their own native IDs above. If one is joined through a
network such as Travelpayouts instead, paste the network's `{url}` template
into `SKYSCANNER_DEEPLINK`, `BOOKING_DEEPLINK` or `VIATOR_DEEPLINK`. The
native ID always wins: the template is used only when that partner's own
ID is not set, so a link never carries two sets of tracking.

### Regional routing

Some links go to a different partner depending on where the trip is — the
reasoning is in the Partner Routing Study. Every regional route is tried
first and falls back to the default partner on its own if it cannot
produce a link, so none of these variables is needed for the site to work.

| Variable | Effect |
|---|---|
| `ROUTING_OFF` | `true` switches every regional route off. All links go to their default partner |
| `ROUTING_SKIP` | Comma list of partners to switch off, e.g. `tripcom` or `tripcom,wise` |
| `TRIPCOM_DEEPLINK` | Affiliate template for Trip.com, same `{url}` / `{subid}` shape as the others |

Both switches take effect on the next click, with no deploy. `/api/health`
shows what is on under `routing`, and names any affiliate template it is
ignoring under `affiliates.problems`.

A template is ignored — and the traveller sent to the partner untracked —
if it does not start with `https://` or does not contain `{url}`. A pasting
mistake in the dashboard costs a commission, never a working link.

Trip.com hotel routing covers only mainland Chinese cities whose Trip.com
city ID has been confirmed by hand; the table and the one-line procedure
for adding a city are at `TRIPCOM_CITY` in `worker.js`.

### Reporting tags

Every template above may also contain `{subid}`, and `BOOKING_LABEL` and
`VIATOR_CAMPAIGN` may contain it too. The Worker replaces it with a short
description of the trip — the kind of link, the destination country, its
airport code, and the month of travel, for example `hotel-lk-cmb-202611`.

This is what turns a commission statement from one number into a report
that says which categories and which destinations earn. Set it once and
the data accumulates from the first click; without it, choosing partners
later is guesswork.

A typical Travelpayouts template looks like:

    https://tp.media/r?marker=123456&u={url}&sub_id={subid}

A template with no `{subid}` in it is sent exactly as written, so nothing
changes for a variable that was set before this existed.

The tag describes the trip and never the traveller. It carries no
passport, no party size, no origin, no session identifier and no random
number — nothing that could link two clicks to one person. `contextTag()`
in `worker.js` is the only place it is built, and the privacy policy
states this in as many words. Anything added to it later must keep that
promise.

The bindings — Workers AI (`AI`), the KV namespace (`RATE`), the rate
limiter (`BURST`) and the static files (`ASSETS`) — are declared in
`wrangler.jsonc`, not in the dashboard. A binding added in the dashboard is
removed by the next deploy.

The free plan allows 1,000 KV writes a day across the account. The Worker
uses one per AI call and one per uncached fare lookup, and carries on
safely if the allowance runs out.

### Who may call the API

The site calls the API on its own address, which is always allowed.
`worker.js` also holds an allowlist near the top for pages served from
anywhere else; a browser request from an origin that is neither gets a
403. Cloudflare's test and preview addresses for this Worker are matched
by a pattern anchored to this account, so previews work without editing
anything.

---

## Data and attribution

The atlas is precomputed and shipped with the app rather than assembled at
request time, so a slow or rate-limited third party cannot ruin a search.
Live sources refine the answer instead of being required for it.

Waypoint uses openly licensed material from Wikipedia, Wikivoyage,
Wikidata, Wikimedia Commons and OpenStreetMap, alongside public climate,
air quality, hazard, exchange rate, holiday, airport and heritage data.
Full credits are at the foot of the homepage and on `sources.html`.

Those materials belong to their owners and are used under their own
licences. See `LICENSE`.

---

## Licence

Proprietary. Copyright © 2026 Prisha iCube. All rights reserved.
See [`LICENSE`](LICENSE).

Third-party material included in this repository remains under its own
licence and is not covered by that copyright claim.

---

## Contact

[waypoint.holiday/contact.html](https://waypoint.holiday/contact.html)

Reports of factual errors are the most useful messages we get.
