/* =====================================================================
   WAYPOINT · CLOUDFLARE WORKER   (optional — the app runs without it)
   ---------------------------------------------------------------------
   Things a static host cannot do:
     GET  /api/where            origin from request.cf — instant, no permission prompt
     POST /api/brief            AI briefing for the winning destination
     POST /api/parse            free text → structured trip parameters
     GET  /api/nearby           Wikidata discovery, cached, correctly identified
     GET  /api/geocode          Nominatim with a real User-Agent and caching
     GET  /api/fx               ECB rates widened by ExchangeRate-API, cached 24h
     GET  /api/climate          Open-Meteo ERA5 climatology, rolling window, cached 30d
     GET  /api/photo            Commons photograph per destination, vetted, cached 30d
     POST /api/live             forecast + air quality + active hazards for the shortlist
     POST /api/reputation       traveller reputation for the shortlist, from free sources

   The last three are new in v3, and they exist for one reason: live data
   generation belongs on the server, not in the browser. Before this, every
   visitor fetched their own exchange rates, their own six ERA5 histories
   and nothing at all about current conditions. Now one cached snapshot
   serves everybody, each observation carries the time it was made, and
   the free-tier limits of the upstream services are respected by
   construction rather than by luck.

   None of the new endpoints need an API key. FIRMS wildfire data is the
   one optional extra — set FIRMS_MAP_KEY as a secret to switch it on:
     wrangler secret put FIRMS_MAP_KEY      (free from firms.modaps.eosdis.nasa.gov)

   REPUTATION SOURCES, and why they are arranged this way.

   /api/reputation answers "do travellers actually rate this place?" The
   obvious sources — Tripadvisor and Google Places — both have the data
   and neither is free in the sense Waypoint needs:

     Tripadvisor Content API   was wired up as an adapter and has since
                               been REMOVED. The legacy Content API sunset
                               on 31 August 2026 in favour of Terra, which
                               would mean signing up to a metered
                               commercial dependency; the free foundation
                               below degrades honestly instead. See the
                               note above taLookup's former position.
     Google Places API         excellent ratings and review counts, but
                               pay-as-you-go with billing enabled and free
                               monthly caps rather than a free tier.

   So neither is the foundation. Both are ADAPTERS, off unless you set a
   key, and the engine cannot tell the difference:

     wrangler secret put GOOGLE_PLACES_KEY  (optional, metered by them)

   The permanently-free foundation is:

     Wikipedia pageviews   attention, not quality — never mixed with rating
     OpenStreetMap         how much of each category actually exists here
     UNESCO + Wikidata     already shipped in the page, used client-side

   Nothing here scrapes anything. Every call is a documented API doing
   what it is meant to do, cached hard so the upstreams see one caller.

   Deploy:
     This file is the Worker behind waypoint.holiday. It is deployed
     automatically by Cloudflare Workers Builds on every push to the main
     branch, together with the static site, using wrangler.jsonc in the
     repository root. Do not paste it into the dashboard editor any more:
     the next push would overwrite whatever was pasted.

     The site and the API share one origin. Requests under /api/ come
     here (assets.run_worker_first in wrangler.jsonc); everything else is
     served straight from the static files and never runs this code, so
     page views do not count towards the Workers daily request limit.

   AI: uses Workers AI by default (bound as env.AI, no key needed). If you
   set ANTHROPIC_API_KEY as a secret it uses Claude instead, which is
   noticeably better at this and costs a fraction of a cent per briefing:
     wrangler secret put ANTHROPIC_API_KEY
===================================================================== */

/* ── WHO MAY CALL THIS ──────────────────────────────────────────────
   The site now calls the API on its own origin, and same-origin calls
   are always allowed (see corsFor). This list only matters for pages
   served from somewhere else. While it says "*" anyone on the internet
   can spend your AI quota.                                            */
const ALLOWED_ORIGINS = [
  "https://waypoint.holiday",
  "https://www.waypoint.holiday"         // www is a different Origin to a browser
];

/* Addresses that cannot be listed in advance, matched by pattern instead.
   Each is anchored at both ends, so nothing outside this account can match. */
const ALLOWED_ORIGIN_PATTERNS = [
  /* Cloudflare's own test addresses for this Worker:
       waypoint.arunkumarkundra.workers.dev            (the Worker itself)
       <version>-waypoint.arunkumarkundra.workers.dev  (preview URLs)
     Anchored to this account's subdomain, so no other account's Worker
     can match. Same-origin calls from these already pass; this covers a
     page on one preview calling the API on another. */
  /^https:\/\/([a-z0-9-]+-)?waypoint\.arunkumarkundra\.workers\.dev$/i
];

/* ── SPEND LIMITS ───────────────────────────────────────────────────
   Only /api/brief and /api/parse cost anything. Both are metered:
   per visitor per day, and a hard ceiling for the whole Worker so a
   bad day can't become a bad bill. Bind a KV namespace called RATE
   to make these survive across edge locations; without it the limits
   still apply per location, which is enough to stop casual abuse.   */
const LIMITS = { perIpPerDay: 40, globalPerDay: 2000, maxBodyBytes: 2048 };

/* ── HOW WE IDENTIFY OURSELVES TO OTHER SERVICES ───────────────────────
   Wikimedia (Wikipedia, Wikivoyage, Commons, Wikidata) and OpenStreetMap
   require a User-Agent that names the tool AND gives a way to contact its
   operator; requests without contact details can be refused (HTTP 403) or
   blocked without notice. Workers share their outgoing IP addresses with
   many other Cloudflare customers, so a clearly identified, polite caller
   matters even more here. Use this for every call to those services.   */
const BOT_UA = "Waypoint/3.3 (https://waypoint.holiday; admin@waypoint.holiday)";

function corsFor(request){
  const o = request.headers.get("Origin") || "";
  /* A page calling the API on its own address. Browsers attach Origin to
     same-origin POSTs, so without this line the site would be refused by
     its own Worker on any address not listed above. */
  let self = "";
  try { self = new URL(request.url).origin; } catch (e) {}
  /* No Origin header at all means no browser is involved — curl, a server,
     a health check. CORS has nothing to say about those, so they pass. */
  const ok = !o
    || o === self
    || ALLOWED_ORIGINS.includes("*")
    || ALLOWED_ORIGINS.includes(o)
    || ALLOWED_ORIGIN_PATTERNS.some(re => re.test(o));
  return {
    origin: o,
    ok,
    headers: {
      ...CORS,
      "Access-Control-Allow-Origin": ok ? (o || "*") : "null",
      "Vary": "Origin"
    }
  };
}

/* NOTE: no Access-Control-Allow-Origin here on purpose.

   It used to say "*", and because every JSON response spreads this object,
   that "*" was stamped onto every reply — silently overwriting whatever
   corsFor() had just worked out. The allowlist above existed but decided
   nothing. The real protection was, and still is, the 403 below; this only
   ever made the allowlist look like it was doing a job it was not.

   The correct origin is now attached once, at the end, by withCors(). */
const CORS = {
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

/* Stamp the right origin on a finished response.

   Done here rather than at the fifty-odd places that build one, so there
   is exactly one answer to "which origin is allowed" and no way for a new
   endpoint to forget. */
function withCors(res, corsInfo){
  // Redirects are top-level navigations, not fetches. Nothing to allow.
  if (res.status >= 300 && res.status < 400) return res;
  // 204/205/304 must not be given a body, so they cannot be rebuilt.
  if (res.status === 204 || res.status === 205 || res.status === 304) return res;

  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin",
    corsInfo.ok ? (corsInfo.origin || "*") : "null");

  /* Without this, a cache that saw one origin's reply could hand the same
     Allow-Origin header to a different one. */
  const vary = out.headers.get("Vary");
  if (!vary) out.headers.set("Vary", "Origin");
  else if (!/\borigin\b/i.test(vary)) out.headers.set("Vary", vary + ", Origin");

  return out;
}
const json = (o, s = 200, extra = {}) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra }
  });

/* ══════════════════════════════════════════════════════════════════
   READY-TO-GO LINK ROUTER

   WHAT THIS DOES, AND WHY IT LOOKS LIKE THIS

   1. readyLink is now async and takes ctx. Two of the new providers
      (TourRadar, Rome2Rio) are reached through SEO slugs rather than a
      query string, and a slug we guess wrong is a 404 in the
      traveller's face. So the Worker now *checks* a small ladder of
      candidate URLs and redirects to the first one that is actually
      alive, falling back to a page that always exists. The check is
      cached at the Cloudflare edge for 30 days, so it costs one HEAD
      request per country per month, not one per click.

   2. Booking.com was silently broken for anyone travelling with
      children. Booking requires one `age=` parameter per child; without
      it an interstitial blocks the whole result set. Fixed.

   3. Nothing was ever sorted. Both Skyscanner and Booking now receive a
      sort and a quality floor derived from the traveller's $ level, so a
      luxury traveller is shown the best-reviewed rooms and direct
      flights, and a budget traveller is shown the cheapest.

   4. No link carried a currency. All of them now do, taken from the
      traveller's own origin country.

   5. New kinds: tours (TourRadar), esim (Airalo), health (CDC),
      advisory (UK FCDO), transfer (now Rome2Rio, not a blind Viator
      text search).

   OPTIONAL WORKER VARIABLES / SECRETS
     SKYSCANNER_MEDIA_PARTNER_ID
     SKYSCANNER_SUBID2
     BOOKING_AID
     BOOKING_LABEL
     VIATOR_PID
     VIATOR_MCID
     VIATOR_CAMPAIGN
     DISCOVER_CARS_AFFILIATE_URL   (template; {destination} {pickupDate} {dropoffDate} {subid})
     TOURRADAR_DEEPLINK            (template containing {url} — the encoded target)
     AIRALO_DEEPLINK               (template containing {url})
     ROME2RIO_DEEPLINK             (template containing {url})
     KAYAK_DEEPLINK                (template containing {url})
     WISE_DEEPLINK                 (template containing {url})
   Leave them unset and this stays a plain-link router.

   6. REPORTING TAGS. Every template above may also contain {subid}, and
      BOOKING_LABEL and VIATOR_CAMPAIGN may contain it too. It is replaced
      with a short description of the trip — kind, destination country,
      airport, month — so a commission statement says which links and
      which destinations are actually working. It holds nothing about the
      traveller, by design: see contextTag() below. A template without the
      placeholder behaves exactly as it did before.
   ══════════════════════════════════════════════════════════════════ */

/* A URL-safe slug from a country name. Accents folded, "&" spelled out,
   apostrophes dropped rather than turned into hyphens ("Cote d'Ivoire"
   must not become "cote-d-ivoire"). */
function slugify(s){
  return String(s||"")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/&/g," and ")
    .replace(/[’'`.]/g,"")
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"");
}

/* Each partner spells the same country differently, and none of them
   publishes the list. These are the ones worth hard-coding; anything not
   named here is slugified from the country name and then verified by
   alive() before we send a traveller to it. */
const CC_TOURRADAR = { US:"usa", GB:"england", CZ:"czech-republic", TR:"turkey",
  AE:"united-arab-emirates", LA:"laos", MM:"myanmar", KR:"south-korea",
  CI:"ivory-coast", CD:"congo", RU:"russia", MK:"north-macedonia" };
const CC_AIRALO = { US:"united-states", GB:"united-kingdom", AE:"united-arab-emirates",
  KR:"south-korea", TR:"turkey", CZ:"czech-republic", HK:"hong-kong", MO:"macao",
  TW:"taiwan", MM:"myanmar", CI:"cote-divoire", MK:"north-macedonia" };
const CC_CDC = { GB:"united-kingdom", AE:"united-arab-emirates", KR:"south-korea",
  TR:"turkey", CZ:"czechia", HK:"hong-kong-sar-china", TW:"taiwan", MM:"burma-myanmar",
  CI:"cote-divoire", MK:"north-macedonia", LA:"laos" };
const CC_FCDO = { US:"usa", AE:"uae", KR:"south-korea", TR:"turkey", CZ:"czechia",
  HK:"hong-kong", MM:"burma", CI:"cote-divoire", MK:"north-macedonia", LA:"laos" };

/* Two candidate spellings, in confidence order, with duplicates removed. */
function ccSlugs(map, cc, name){
  const out=[];
  const fix = map[String(cc||"").toUpperCase()];
  if(fix) out.push(fix);
  const s = slugify(name);
  if(s && !out.includes(s)) out.push(s);
  return out;
}

/* fetch() with a hard ceiling, because a partner that hangs must not hang
   the redirect. Whatever loses the race is treated as "unknown". */
function raced(promise, ms){
  return Promise.race([
    promise,
    new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), ms))
  ]);
}

/* Is this URL a real page? Cached at the edge for 30 days under a
   synthetic key, so the cost is one HEAD per country per month rather
   than one per click. Any failure at all answers "no", and the caller
   always has a fallback that cannot 404. */
async function alive(url, ctx){
  let cache=null, key=null;
  try{
    cache = caches.default;
    key = new Request("https://waypoint.invalid/alive?u="+encodeURIComponent(url));
    const hit = await cache.match(key);
    if(hit) return (await hit.text())==="1";
  }catch(e){ /* no cache available — just do the check */ }

  let ok=false;
  const headers={ "User-Agent":
    "Mozilla/5.0 (compatible; Waypoint/1.0; +https://waypoint.holiday) link-check" };
  try{
    let r = await raced(fetch(url,{method:"HEAD",redirect:"follow",headers}), 2500);
    /* Some SEO stacks refuse HEAD outright. A 405 says nothing about
       whether the page exists, so ask again properly. */
    if(r.status===405 || r.status===501)
      r = await raced(fetch(url,{method:"GET",redirect:"follow",headers}), 3000);
    ok = r.status>=200 && r.status<400;
    /* A slug that does not exist is sometimes redirected to the homepage
       rather than 404'd. That is a "no", not a "yes". */
    if(ok && r.redirected){
      try{ const fin=new URL(r.url); if(fin.pathname==="/"||fin.pathname==="") ok=false; }catch(e){}
    }
  }catch(e){ ok=false; }

  try{
    if(cache && key){
      const res=new Response(ok?"1":"0",{headers:{"Cache-Control":"public, max-age=2592000"}});
      if(ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key,res)); else await cache.put(key,res);
    }
  }catch(e){ /* caching is an optimisation, never a requirement */ }
  return ok;
}

/* Walk a ladder of candidate URLs and return the first that resolves.
   `guaranteed` is a page that certainly exists and is never checked — it
   is the answer when nothing else worked.

   The cap matters, and it is why guaranteed is a separate argument
   rather than the last item in the list: an earlier version put the
   fallback at the end of the array, and a long ladder of hopeful
   slugs pushed the one candidate we were confident about (the country
   page) past the cap. Sri Lanka, which has 700 tours listed, landed on
   the TourRadar homepage. Candidates get checked; the fallback does
   not compete with them. */
async function firstAlive(candidates, ctx, guaranteed){
  /* Checked all at once, not one after another, so a longer ladder does
     not make the traveller wait longer. The first alive one IN PRIORITY
     ORDER still wins. */
  const list=[...new Set(candidates.filter(Boolean))].slice(0,8);
  const ok=await Promise.all(list.map(u=>alive(u,ctx).catch(()=>false)));
  const i=ok.indexOf(true);
  return i>=0 ? list[i] : guaranteed;
}


/* An affiliate network usually wants the destination URL wrapped inside
   its own tracking URL. One template, one placeholder, no per-provider
   code — and with no template set the traveller goes straight there.

   A BADLY PASTED TEMPLATE MUST NEVER BREAK A LINK. These values are
   typed into the Cloudflare dashboard by hand, and two mistakes are easy:
   leaving out {url} (so every click lands on the same fixed page, and the
   traveller's search is thrown away) or pasting something that is not a
   web address at all. In either case the template is ignored and the
   traveller goes to the partner untracked — which loses a commission,
   and loses nothing else. /api/health names any template it ignores. */
function templateUsable(template){
  const t=String(template||"");
  return t.includes("{url}") && /^https?:\/\//i.test(t.trim());
}
function wrapAffiliate(template,url,subid){
  if(!template || !templateUsable(template)) return url;
  const out = String(template).trim()
    .replaceAll("{url}",encodeURIComponent(url))
    .replaceAll("{subid}",encodeURIComponent(subid||""));
  try{ const u=new URL(out); if(u.protocol==="https:"||u.protocol==="http:") return out; }catch(e){}
  return url;
}

/* THE TRACKING TAG, AND WHY IT IS DELIBERATELY DULL.

   Every affiliate network lets a link carry a label that comes back in
   the reports. Without one, a commission statement is a single number:
   money arrived, from somewhere, for something. With one, it says which
   kind of link and which destination produced it — which is the only way
   to find out whether the right partner is being used for a given part
   of the world, rather than guessing.

   What goes in it: the kind of link, the destination's country, its
   airport code where there is one, and the month of travel.

   What must never go in it: anything about the traveller. Not the
   passport, not the party, not the origin, not a session id, not a
   random number that would make two clicks recognisably the same person.
   The privacy policy promises this in as many words. The tag describes
   the trip; it does not describe anybody.

   Kept to lowercase letters, digits and hyphens because the networks
   differ on what else they accept, and capped well short of any of their
   limits. */
function contextTag(kind, cc, country, destination, date){
  const month = /^\d{4}-\d{2}/.test(String(date||"")) ? String(date).slice(0,7).replace("-","") : "";
  const where = String(cc||"").toLowerCase() || slugify(country).slice(0,12);
  const dest  = /^[A-Z]{3}$/.test(String(destination||"")) ? String(destination).toLowerCase() : "";
  return [kind, where, dest, month]
    .filter(Boolean).join("-")
    .toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,48);
}

/* ── CONTEXT ROUTING ────────────────────────────────────────────────
   Some links go to a different partner depending on where the trip is.
   The Partner Routing Study explains every choice; this is the code.

   THE ONE RULE: A REGIONAL ROUTE IS AN EXTRA, NEVER A REPLACEMENT.
   Each route is tried FIRST, and it either produces a complete web
   address or it produces nothing. Nothing means the ordinary default
   code runs, byte for byte as it did before routing existed. There is
   no path by which a missing ID, a bad template, an unknown city or a
   switched-off partner leaves a traveller without a working link.

   TWO SWITCHES IN THE CLOUDFLARE DASHBOARD, NO DEPLOY NEEDED:
     ROUTING_OFF  = true          every regional route off; all defaults
     ROUTING_SKIP = tripcom       just these partners off (comma list)
   If a partner redesigns its site and a regional link starts landing
   badly, one of these takes it out of service in thirty seconds, and
   the default partner takes over on the next click. /api/health shows
   what is switched on.

   AFFILIATE CODES: every regional partner reads its own
   <NAME>_DEEPLINK template — the same {url} and {subid} shape as the
   Airalo and TourRadar ones. Set it and that partner's links are
   tracked; leave it and they go untracked. No code change either way. */
function routingOn(env, partner){
  if(String(env.ROUTING_OFF||"").trim().toLowerCase()==="true") return false;
  const skip=String(env.ROUTING_SKIP||"").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  return !skip.includes(partner);
}

/* Anything a route builds passes through here. A route that returns
   something that is not a complete https address is treated exactly as
   a route that returned nothing. */
function httpsOrNull(s){
  try{ const u=new URL(String(s||"")); return u.protocol==="https:" ? u.toString() : null; }
  catch(e){ return null; }
}

/* TRIP.COM, FOR HOTELS IN MAINLAND CHINA.

   Why: many Chinese hotels are not licensed to take foreign guests and
   will refuse a foreign passport at check-in. Trip.com's international
   site lets the traveller filter for the ones that are; Booking.com and
   Agoda leave it to them.

   Why a table: Trip.com's hotel search takes a NUMERIC city id, not a
   name, and a wrong id does not fail — it quietly shows the wrong city.
   No live check can catch that. So a city is routed only once its id
   has been confirmed by hand on trip.com, and every city not in this
   table keeps going to Booking.com exactly as before.

   Keyed by the destination's airport code, because that is the one
   identifier the destination data holds that never changes wording.

   TO ADD A CITY: on trip.com, search hotels for the city with any
   dates, then look at the address bar. The number after "city=" is the
   id. Add one line below. That is the whole job.

     PVG  Shanghai                     2    confirmed
     PEK  Beijing                      —    to confirm
     KWL  Guilin & Yangshuo            —    to confirm (Yangshuo is where most stay)
     XIY  Xi'an                        —    to confirm
     CTU  Chengdu & Jiuzhaigou         —    to confirm
     LJG  Yunnan (Lijiang)             —    to confirm
     DYG  Zhangjiajie                  —    to confirm
     HGH  Hangzhou & Suzhou            —    to confirm
     HRB  Harbin                       —    to confirm
     LXA  Lhasa & Tibet                —    to confirm
     KHG  Kashgar & Xinjiang           —    to confirm                   */
const TRIPCOM_CITY = {
  PVG: 2      // Shanghai
};

/* Only the parameters confirmed in Trip.com's own list URLs: city,
   dates, adults, rooms, currency. Children are deliberately NOT sent.
   Trip.com wants an age per child in a format we have not been able to
   confirm, and a guessed format risks exactly the kind of interstitial
   that once broke every family search on Booking. Two adults arrive
   prefilled and the family adds the children on the page — incomplete,
   but never wrong. */
function tripcomHotel(air, checkin, checkout, adults, rooms, currency){
  const id = TRIPCOM_CITY[air];
  if(!id) return null;
  const q=new URL("https://www.trip.com/hotels/list");
  q.searchParams.set("city",String(id));
  if(/^\d{4}-\d{2}-\d{2}$/.test(checkin) && /^\d{4}-\d{2}-\d{2}$/.test(checkout) && checkout>checkin){
    q.searchParams.set("checkIn",checkin);
    q.searchParams.set("checkOut",checkout);
  }
  q.searchParams.set("adult",String(adults));
  q.searchParams.set("crn",String(rooms));
  if(currency) q.searchParams.set("barCurr",currency);
  return q.toString();
}

/* WISE — WHERE THE CARD CAN ACTUALLY BE ORDERED.

   The card link used to send every traveller, from every country, to
   Wise's UK card page. For most of this site's readers that is a
   product they cannot order.

   From Wise's own help centre ("Can I get the Wise card in my
   country?"), plus India, where Wise launched its travel card on
   8 December 2025 — the help page had not caught up when this was
   written, which is exactly why the page itself is checked live below
   rather than trusted. UK microstates and territories share the UK
   card and are left out: the site does not route anyone from them. */
const WISE_CARD = new Set((
  "AU BR CA JP MY NZ PH SG CH GB US IN " +
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IS IT IE LV LI LT LU MT NL NO PL PT RO SK SI ES SE"
).split(" "));
const WISE_CARD_HELP = "https://wise.com/help/articles/2968915/can-i-get-the-transferwise-card-in-my-country";

async function readyLink(request,env,ctx){
  const u=new URL(request.url), p=u.searchParams, kind=p.get("kind");
  const origin=cleanToken(p.get("origin"),8).toUpperCase();
  const destination=cleanToken(p.get("destination"),80).toUpperCase();
  const outboundDate=cleanToken(p.get("outboundDate"),10);
  const inboundDate=cleanToken(p.get("inboundDate"),10);
  const adults=Math.max(1,Math.min(8,parseInt(p.get("adults")||"1",10)||1));
  const children=Math.max(0,Math.min(8,parseInt(p.get("children")||"0",10)||0));
  const cabin=["economy","premiumeconomy","business","first"].includes(p.get("cabinclass"))
    ? p.get("cabinclass") : "economy";

  /* Shared travel context. Every one of these used to be missing, which
     is why an Indian traveller was quoted dollars on both partners. */
  const market   = (cleanToken(p.get("market"),2).toUpperCase().replace(/[^A-Z]/g,"")) || "";
  const locale   = cleanToken(p.get("locale"),10).replace(/[^A-Za-z-]/g,"") || "";
  const currency = cleanToken(p.get("currency"),3).toUpperCase().replace(/[^A-Z]/g,"") || "";
  const country  = decodeOnceIfEncoded(cleanToken(p.get("country"),80));
  const cc       = cleanToken(p.get("cc"),2).toUpperCase().replace(/[^A-Z]/g,"");
  /* "true" only when the page says so. Anything else means no. */
  const wantDirect = p.get("direct")==="true";

  /* One tag per click, built once and offered to every branch below.
     Nothing uses it unless the matching affiliate template or variable
     asks for it, so this costs nothing until an account exists. */
  const subid = contextTag(kind, cc, country, destination,
    outboundDate || cleanToken(p.get("checkin"),10) || cleanToken(p.get("pickupDate"),10));

  let target="";

  /* ── FLIGHTS ─────────────────────────────────────────────────── */
  if(kind==="flight"){
    /* Skyscanner's *path* deep-link takes yymmdd, not ISO. Handing it
       2026-08-29 lands the traveller on an error page rather than a
       search. A one-way trip omits the return segment entirely — leaving
       it empty produced a double slash, which Skyscanner also rejects.
       (The affiliate day-view API below is a different endpoint and does
       want ISO, so the dates are passed through to it unchanged.) */
    const ymd=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)?d.slice(2,4)+d.slice(5,7)+d.slice(8,10):"";
    const out=ymd(outboundDate), back=ymd(inboundDate);
    if(origin && destination && out){
      target=`https://www.skyscanner.net/transport/flights/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}/${out}/${back?back+"/":""}`;
    }else{
      target="https://www.skyscanner.net/transport/flights/";
    }
    const q=new URL(target);
    q.searchParams.set("adultsv2",String(adults));
    /* Skyscanner wants an age per child, not a count. We can't know the
       ages, so 10 is a placeholder the traveller can adjust on arrival —
       without this the children were silently dropped from the search. */
    if(children)q.searchParams.set("childrenv2",Array(children).fill("10").join("|"));
    q.searchParams.set("cabinclass",cabin);
    /* THIS USED TO BE HARDCODED false FOR EVERYONE. Skyscanner exposes no
       sort parameter on the public results page, so preferdirects is the
       only lever we have for "show me the convenient flight, not the
       cheapest one" — and that is exactly what somebody flying business,
       or flying with a four-year-old, is asking for. */
    q.searchParams.set("preferdirects", wantDirect?"true":"false");
    if(market)  q.searchParams.set("market",market);
    if(locale)  q.searchParams.set("locale",locale);
    if(currency)q.searchParams.set("currency",currency);
    target=q.toString();

    /* Once approved, use Skyscanner's official Affiliates Link API. */
    if(env.SKYSCANNER_MEDIA_PARTNER_ID && origin && destination && outboundDate){
      const a=new URL("https://skyscanner.net/g/referrals/v1/flights/day-view");
      a.searchParams.set("mediaPartnerId",env.SKYSCANNER_MEDIA_PARTNER_ID);
      a.searchParams.set("origin",origin);
      a.searchParams.set("destination",destination);
      a.searchParams.set("outboundDate",outboundDate);
      if(inboundDate)a.searchParams.set("inboundDate",inboundDate);
      a.searchParams.set("adultsv2",String(adults));
      a.searchParams.set("cabinclass",cabin);
      a.searchParams.set("preferDirects", wantDirect?"true":"false");
      a.searchParams.set("market",market||"IN");
      a.searchParams.set("locale",locale||"en-IN");
      if(currency)a.searchParams.set("currency",currency);
      /* Skyscanner reports on two labels. subid2 stays whatever the
         dashboard says — it is normally a fixed name for the whole site.
         subid1 carries the per-click context, so the report separates a
         Colombo search from a Lisbon one. */
      a.searchParams.set("subid1",subid);
      if(env.SKYSCANNER_SUBID2)a.searchParams.set("subid2",env.SKYSCANNER_SUBID2);
      target=a.toString();
    }
  }

  /* ── SOMEWHERE TO STAY ───────────────────────────────────────── */
  else if(kind==="hotel"){
    /* REGIONAL ROUTE — mainland China → Trip.com, only for cities whose
       Trip.com id is confirmed. Anything else falls straight through to
       Booking.com below, which is unchanged. */
    if(cc==="CN" && routingOn(env,"tripcom")){
      const air=cleanToken(p.get("airport"),4).toUpperCase().replace(/[^A-Z]/g,"");
      const rooms=Math.max(1,Math.min(adults,parseInt(p.get("rooms")||"1",10)||1));
      const raw=httpsOrNull(tripcomHotel(air,
        cleanToken(p.get("checkin"),10), cleanToken(p.get("checkout"),10),
        adults, rooms, currency));
      if(raw) return Response.redirect(wrapAffiliate(env.TRIPCOM_DEEPLINK, raw, subid), 302);
    }

    /* The page used to encode the destination before handing it to
       URLSearchParams, so it arrived encoded twice and Booking.com
       searched for the literal text "Kandy%2C%20Sri%20Lanka". The page is
       fixed, but cached copies of it are still out there, so undo it
       here too. */
    const ss=decodeOnceIfEncoded(cleanToken(p.get("destination"),180));
    const q=new URL("https://www.booking.com/searchresults.html");
    q.searchParams.set("ss",ss);
    q.searchParams.set("checkin",cleanToken(p.get("checkin"),10));
    q.searchParams.set("checkout",cleanToken(p.get("checkout"),10));
    q.searchParams.set("group_adults",String(adults));
    q.searchParams.set("group_children",String(children));
    q.searchParams.set("no_rooms",String(Math.max(1,Math.min(adults,parseInt(p.get("rooms")||"1",10)||1))));

    /* THIS WAS A LIVE BUG. Booking requires one age= per child whenever
       group_children is greater than zero. Without the ages it serves an
       interstitial instead of results, so every family search returned
       nothing usable. We do not know real ages, so the page sends a
       default the traveller can change on arrival — but it must be sent. */
    if(children){
      const ages=cleanToken(p.get("childAges"),40).split(",")
        .map(x=>parseInt(x,10)).filter(n=>isFinite(n)&&n>=0&&n<=17);
      while(ages.length<children) ages.push(8);
      ages.slice(0,children).forEach(a=>q.searchParams.append("age",String(a)));
    }

    /* Star class AND a review-score floor, in one nflt string. The floor
       is what stops a 6.1-rated guesthouse sitting next to a good one. */
    if(p.get("hotelClasses"))q.searchParams.set("nflt",cleanToken(p.get("hotelClasses"),160));

    /* Sort, chosen by what the traveller told us they are spending.
       Cheapest first at the bottom of the ladder; best reviewed first at
       the top, because the class filter has already settled the standard
       and price is no longer the question being asked. */
    const order=cleanToken(p.get("order"),40);
    if(["price","bayesian_review_score","bayesian_review_score_and_price",
        "class","class_desc","distance_from_search","popularity"].includes(order))
      q.searchParams.set("order",order);

    if(currency)q.searchParams.set("selected_currency",currency);
    if(locale)  q.searchParams.set("lang",locale.toLowerCase());

    /* Coordinates as a second signal. A place name has to survive the
       partner's autocomplete; a coordinate does not. Ignored harmlessly
       if Booking does not use them, and the name still leads. */
    const lat=parseFloat(p.get("lat")), lon=parseFloat(p.get("lon"));
    if(isFinite(lat)&&isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180){
      q.searchParams.set("latitude",lat.toFixed(4));
      q.searchParams.set("longitude",lon.toFixed(4));
    }
    if(env.BOOKING_AID)q.searchParams.set("aid",env.BOOKING_AID);
    /* Booking's one reporting field is `label`. Put {subid} anywhere in
       BOOKING_LABEL and it is replaced with the context tag; a label
       with no placeholder is sent exactly as it was before. */
    if(env.BOOKING_LABEL)q.searchParams.set("label",
      String(env.BOOKING_LABEL).replaceAll("{subid}",subid));
    target=q.toString();
  }

  /* ── THINGS TO DO ────────────────────────────────────────────── */
  else if(kind==="activity"){
    const q=new URL("https://www.viator.com/searchResults/all");
    q.searchParams.set("text",decodeOnceIfEncoded(cleanToken(p.get("query"),180)));
    if(currency)q.searchParams.set("currency",currency);
    if(env.VIATOR_PID && env.VIATOR_MCID){
      q.searchParams.set("pid",env.VIATOR_PID);
      q.searchParams.set("mcid",env.VIATOR_MCID);
      q.searchParams.set("medium","link");
      /* Same idea as Booking's label: {subid} in VIATOR_CAMPAIGN is
         replaced, and a campaign without one is unchanged. */
      if(env.VIATOR_CAMPAIGN)q.searchParams.set("campaign",
        String(env.VIATOR_CAMPAIGN).replaceAll("{subid}",subid));
    }
    target=q.toString();
  }

  /* ── PACKAGED / MULTI-DAY TOURS  (TourRadar) ─────────────────── */
  else if(kind==="tours"){
    /* TourRadar has no free-text search URL. It has a slug grammar
       instead, and several of those slugs happen to line up exactly with
       things Waypoint already knows about the traveller:

         /d/{country}                a country's tours   (always exists)
         /i/{country}-family         travelling with kids
         /i/{country}-safari         and other travel styles
         /l/d-luxury-{country}       the top of the budget ladder
         /l/d-budget-{country}       the bottom of it
         /m/{country}-{month}        departures in one month

       They are separate landing pages, not combinable filters, and they
       only exist where TourRadar has inventory — so we try the most
       specific one we can justify, then a second, then fall back to the
       country page, which is always there. alive() decides. */
    const slugs=ccSlugs(CC_TOURRADAR,cc,country);
    const base="https://www.tourradar.com";
    const s0=slugs[0]||"";
    const style=slugify(cleanToken(p.get("tourStyle"),40));
    const money=cleanToken(p.get("tourBudget"),10);   // "luxury" | "budget" | ""
    const month=slugify(cleanToken(p.get("month"),12));
    /* Priority order, and only the top two are ever tried, so the country
       page below always stays inside the check budget. Family first
       because a tour that will not take a seven-year-old is not an
       option at all; then the travel style, which is what the trip is
       actually about; then the budget tier. */
    const specific=[];
    if(s0){
      if(children>0)                        specific.push(`${base}/i/${s0}-family`);
      if(style)                             specific.push(`${base}/i/${s0}-${style}`);
      if(money==="luxury"||money==="budget")specific.push(`${base}/l/d-${money}-${s0}`);
      if(month)                             specific.push(`${base}/m/${s0}-${month}`);
    }
    /* REGION PAGES FIRST. "Leh & Ladakh" has its own TourRadar page at
       /v/region-leh-ladakh; sending that traveller to "India tours in
       September" was technically valid and practically useless. Each part
       of the atlas name is tried as a region; the country pages follow. */
    const area=decodeOnceIfEncoded(cleanToken(p.get("area"),120));
    const regionSlugs=[];
    const addR=x=>{
      const s=slugify(String(x||"").replace(/&/g," "));
      if(s.length>=3 && !regionSlugs.includes(s) && !slugs.includes(s)) regionSlugs.push(s);
    };
    if(area){
      const inside=(area.match(/\(([^)]*)\)/)||[])[1]||"";
      const outer=area.replace(/\(.*?\)/g,"").trim();
      addR(outer);
      const parts=x=>x.split(/\s*[&,\/]\s*|\s+and\s+/i);
      parts(outer).forEach(addR);
      parts(inside).forEach(addR);
    }
    const regional=[];
    if(regionSlugs[0] && style) regional.push(`${base}/vi/region-${regionSlugs[0]}-${style}`);
    regionSlugs.slice(0,3).forEach(s=>regional.push(`${base}/v/region-${s}`));
    const cands=regional.slice(0,4)
      .concat(specific.slice(0,2), slugs.map(s=>`${base}/d/${s}`));
    target=wrapAffiliate(env.TOURRADAR_DEEPLINK, await firstAlive(cands,ctx,base+"/"), subid);
  }

  /* ── GETTING IN FROM THE AIRPORT  (Rome2Rio) ─────────────────── */
  else if(kind==="transfer"){
    /* FIRST ATTEMPT AT THIS WAS WRONG IN TWO WAYS, AND BOTH SHOWED UP AS
       the Rome2Rio homepage.

       One: a bare IATA code is not a place Rome2Rio recognises. Its real
       route pages look like /s/Colombo-Airport-CMB/Kandy — the airport's
       city, the word Airport, then the code. The page now builds that
       label from the airport master and sends it whole.

       Two: this went through alive() like the other new links, and
       Rome2Rio refuses an automated HEAD, so the check said "dead" for a
       page that was perfectly fine and we fell through to the homepage.
       There is nothing to verify here anyway — Rome2Rio generates a
       route page for any two places it can resolve, rather than serving
       404s from a fixed list of slugs. So: no check. */
    const from=decodeOnceIfEncoded(cleanToken(p.get("from"),90))
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .trim().replace(/\s+/g,"-").replace(/[^A-Za-z0-9-]/g,"");
    const to=decodeOnceIfEncoded(cleanToken(p.get("destination"),80))
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .trim().replace(/\s+/g,"-").replace(/[^A-Za-z0-9-]/g,"");
    const base="https://www.rome2rio.com";
    target=wrapAffiliate(env.ROME2RIO_DEEPLINK,
      (from&&to) ? `${base}/s/${from}/${to}` : base+"/", subid);
  }

  /* ── SELF-DRIVE ──────────────────────────────────────────────── */
  else if(kind==="car"){
    /* DiscoverCars.com/search is not a page. It returns "Page not found",
       which is exactly what a traveller saw. It is not a mistake in the
       parameters either: DiscoverCars resolves a location to an internal
       ID and then POSTs to create a search, so there is no URL anywhere
       that carries a place name and a pair of dates. Nothing we can build
       by hand will ever prefill it.

       Their affiliate programme does issue working deep links, so that
       path is kept and used whenever the template is set. Without one,
       the fallback is KAYAK, which does take a plain place name and ISO
       dates in the path — /cars/Kandy,Sri-Lanka/2026-11-14/2026-11-21 —
       and lands on a real prefilled comparison rather than a 404. */
    const template=env.DISCOVER_CARS_AFFILIATE_URL;
    if(template){
      target=template.replaceAll("{destination}",encodeURIComponent(decodeOnceIfEncoded(cleanToken(p.get("destination"),100))))
        .replaceAll("{pickupDate}",encodeURIComponent(cleanToken(p.get("pickupDate"),10)))
        .replaceAll("{dropoffDate}",encodeURIComponent(cleanToken(p.get("dropoffDate"),10)))
        .replaceAll("{subid}",encodeURIComponent(subid));
    }else{
      const loc=decodeOnceIfEncoded(cleanToken(p.get("carLocation"),80))
        .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
        .trim().replace(/[^A-Za-z0-9,\s-]/g,"").replace(/\s+/g,"-");
      const from=cleanToken(p.get("pickupDate"),10), to=cleanToken(p.get("dropoffDate"),10);
      const dated=/^\d{4}-\d{2}-\d{2}$/.test(from)&&/^\d{4}-\d{2}-\d{2}$/.test(to);
      target = loc
        ? `https://www.kayak.com/cars/${encodeURIComponent(loc).replace(/%2C/g,",")}${dated?`/${from}/${to}`:""}`
        : "https://www.kayak.com/cars";
      target = wrapAffiliate(env.KAYAK_DEEPLINK, target, subid);
    }
  }

  /* ── THE LIVE RATE, AND A WAY TO CARRY MONEY  (Wise) ─────────── */
  else if(kind==="card"){
    /* The previous URL here — wise.com/currency-converter/{ccy}-currency
       — was invented and 404s. Wise namespaces every converter page
       under a country segment, so the working shape is
       wise.com/gb/currency-converter/inr-to-lkr-rate. Not every country
       has a segment, so this always uses the English one, which resolves
       for everybody.

       Two pages, because they answer two questions: the converter is
       today's mid-market rate and commits the reader to nothing, and
       /card/ is the product itself. Deliberately one provider rather
       than a ranked list of cards — the best way
       to carry money abroad depends on the traveller's own bank and
       nationality, and those fee structures change faster than this file
       does. Ranking them from stale knowledge would be advice we cannot
       stand behind. */
    const pair=cleanToken(p.get("pair"),12).toLowerCase().replace(/[^a-z-]/g,"");
    const page=cleanToken(p.get("page"),8);
    const conv=/^[a-z]{3}-to-[a-z]{3}$/.test(pair)
      ? `https://wise.com/gb/currency-converter/${pair}-rate`
      : "https://wise.com/gb/currency-converter/";

    /* THE CARD PAGE, BY WHERE THE TRAVELLER LIVES — not by where they
       are going. Three outcomes, and the first is the only new one:

         home country issues the card, and Wise has a live page for it
             → that country's card page
         home country issues the card, but no local page answers
             → the UK card page, as before
         home country is known and does NOT issue the card
             → Wise's own "can I get the card in my country?" article,
               which says so honestly and offers their waitlist

       An unknown home country (older cached pages send none) gets the
       UK page, exactly as before. The local page is checked live and
       the answer cached for a month, so a page Wise renames or retires
       falls back by itself. */
    let cardPage="https://wise.com/gb/card/";
    if(page==="card" && /^[A-Z]{2}$/.test(market) && routingOn(env,"wise")){
      if(WISE_CARD.has(market)){
        if(market!=="GB"){
          const m=market.toLowerCase();
          cardPage=await firstAlive(
            [`https://wise.com/${m}/card/`, `https://wise.com/${m}/travel-card/`],
            ctx, "https://wise.com/gb/card/");
        }
      }else{
        cardPage=WISE_CARD_HELP;
      }
    }
    target=wrapAffiliate(env.WISE_DEEPLINK,
      page==="card" ? cardPage : conv, subid);
  }

  /* ── DATA ON ARRIVAL  (Airalo eSIM) ──────────────────────────── */
  else if(kind==="esim"){
    const slugs=ccSlugs(CC_AIRALO,cc,country);
    const cands=slugs.map(s=>`https://www.airalo.com/${s}-esim`);
    target=wrapAffiliate(env.AIRALO_DEEPLINK, await firstAlive(cands,ctx,"https://www.airalo.com/"), subid);
  }

  /* ── HEALTH  (US CDC Travelers' Health) ──────────────────────── */
  else if(kind==="health"){
    /* Free, authoritative, and it has a real page per country rather
       than a marketing page with a search box. Not commercial and never
       will be — it is here because it is the right answer. */
    const slugs=ccSlugs(CC_CDC,cc,country);
    const cands=slugs.map(s=>`https://wwwnc.cdc.gov/travel/destinations/traveler/none/${s}`);
    target=await firstAlive(cands,ctx,"https://wwwnc.cdc.gov/travel/destinations/list");
  }

  /* ── SAFETY  (UK FCDO travel advice) ─────────────────────────── */
  else if(kind==="advisory"){
    /* The FCDO's per-country pages are the most detailed free advisories
       published by any government, and they are the same for everyone
       rather than being written for one nationality. The page labels
       them as British advice so nobody is misled about the source. */
    const slugs=ccSlugs(CC_FCDO,cc,country);
    const cands=slugs.map(s=>`https://www.gov.uk/foreign-travel-advice/${s}`);
    target=await firstAlive(cands,ctx,"https://www.gov.uk/foreign-travel-advice");
  }

  else return json({error:"unknown link kind"},400);

  /* NETWORK LINKS FOR THE THREE PARTNERS THAT HAVE THEIR OWN PROGRAMMES.
     Skyscanner, Booking.com and Viator each take a native affiliate id
     (above). If one of them is joined through a network like
     Travelpayouts instead, the network hands out a {url} wrapper, and
     it goes here:
       SKYSCANNER_DEEPLINK   BOOKING_DEEPLINK   VIATOR_DEEPLINK
     THE NATIVE ID ALWAYS WINS. The wrapper is applied only when that
     partner's own id is NOT set, so a link can never carry two sets of
     tracking and have a commission disputed between them. /api/health
     warns if both are set. Only the default partner's links reach this
     point — a regionally routed link has already left above. */
  const netLink = {
    flight:   !env.SKYSCANNER_MEDIA_PARTNER_ID && env.SKYSCANNER_DEEPLINK,
    hotel:    !env.BOOKING_AID                 && env.BOOKING_DEEPLINK,
    activity: !env.VIATOR_PID                  && env.VIATOR_DEEPLINK
  }[kind];
  if(netLink) target = wrapAffiliate(netLink, target, subid);

  return Response.redirect(target,302);
}

export default {
  async fetch(request, env, ctx) {
    /* Anything outside /api/ belongs to the static site. Cloudflare serves
       existing files without ever calling this code; the only requests that
       get here are for files that do not exist (a mistyped address, a
       deleted image). Hand those back to the asset server so the visitor
       gets the proper 404 page rather than a JSON error.
       env.ASSETS is only absent if this file is ever deployed on its own,
       without the site; the check keeps that case working. */
    if (env.ASSETS) {
      const path = new URL(request.url).pathname;
      if (path !== "/api" && !path.startsWith("/api/")) return env.ASSETS.fetch(request);
    }

    const corsInfo = corsFor(request);

    if (request.method === "OPTIONS")
      return new Response(null, { headers: corsInfo.headers });

    // A browser request from somewhere that isn't yours doesn't get served.
    if (corsInfo.origin && !corsInfo.ok)
      return withCors(json({ error: "origin not allowed" }, 403), corsInfo);

    return withCors(await route(request, env, ctx), corsInfo);
  }
};

/* Everything below used to sit inside fetch(). It was lifted out so the
   CORS header could be applied in one place, on the way out. The routing
   itself is unchanged. */
async function route(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "");

    try {
      if (p === "" || p === "/" || p === "/api/health") return health(env);
      if (p === "/api/where")   return where(request);
      if (p === "/api/nearby")  return nearby(request, ctx, env);
      if (p === "/api/geocode") return geocode(request, ctx, env);
      // Free, keyless, cached. None of these cost anything, so none are metered.
      if (p === "/api/holidays") return holidays(request, ctx);
      if (p === "/api/fx")      return fx(ctx);
      if (p === "/api/prices")  return prices(ctx);
      if (p === "/api/fares")   return fares(request, ctx, env);
      if (p === "/api/climate") return climate(request, ctx);
      if (p === "/api/photo")   return photo(request, ctx, env);
      if (p === "/api/live") {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        return live(request, env, ctx);
      }
      /* Free by default. The optional commercial adapters inside it are
         metered by their own providers, and are simply absent unless a
         key is set — so this endpoint cannot surprise you with a bill. */
      if (p === "/api/reputation") {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        return reputation(request, env, ctx);
      }
      /* Ready-to-go links are intentionally GET redirects. The browser never
         receives affiliate IDs; the Worker decides whether a provider is
         currently affiliate-enabled and otherwise falls back to the same
         normal public search page. */
      if (p === "/api/ready-link") {
        if (request.method !== "GET") return json({ error: "GET only" }, 405);
        return readyLink(request, env, ctx);
      }

      // Everything below costs money, so it gets metered.
      if (p === "/api/brief" || p === "/api/parse") {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        const len = +(request.headers.get("Content-Length") || 0);
        if (len > LIMITS.maxBodyBytes) return json({ error: "body too large" }, 413);
        const gate = await meter(request, env, ctx);
        if (!gate.ok) return json({ error: gate.why, retryAfter: gate.retryAfter }, 429,
          { "Retry-After": String(gate.retryAfter || 3600) });
        return p === "/api/brief" ? brief(request, env, ctx) : parse(request, env);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
}


/* ── READY-TO-GO PARTNER LINKS ──────────────────────────────────────
   Commercial credentials live here, never in the site's public files.

   Optional Worker variables/secrets:
     SKYSCANNER_MEDIA_PARTNER_ID
     SKYSCANNER_SUBID2
     BOOKING_AID
     BOOKING_LABEL
     VIATOR_PID
     VIATOR_MCID
     VIATOR_CAMPAIGN
     DISCOVER_CARS_AFFILIATE_URL (optional URL template; {destination} is replaced)
     TOURRADAR_DEEPLINK      (optional URL template containing {url})
     AIRALO_DEEPLINK         (optional URL template containing {url})
     ROME2RIO_DEEPLINK       (optional URL template containing {url})
     KAYAK_DEEPLINK          (optional URL template containing {url})
     WISE_DEEPLINK           (optional URL template containing {url})
   Any of these may also contain {subid}, which is replaced with a
   non-personal description of the trip for the partner's own reports.

   Leave them unset and the endpoint remains a normal-link router.
   This means the site can launch before any affiliate approvals and later
   switch attribution without changing the site's files.
*/
function cleanToken(v,max=120){
  return String(v||"").trim().slice(0,max);
}

/* A value that still contains %XX after URLSearchParams has already decoded
   it was encoded twice by the caller. Decode one more layer, and only one.
   Anything that fails to decode is left exactly as it came in. */
function decodeOnceIfEncoded(s){
  if(!/%[0-9A-Fa-f]{2}/.test(s))return s;
  try{ return decodeURIComponent(s); }catch{ return s; }
}


/* ── PUBLIC HOLIDAYS ────────────────────────────────────────────────
   The browser used to call date.nager.at directly, once per visitor, with
   no cache and no protection from a CORS change at the far end. When that
   call failed the app had no holiday windows at all — and holiday windows
   are the feature, not a garnish.

   Here it is one cached server-side call for everybody. Each year is
   fetched independently so a failure on one cannot empty the other, and a
   partial result is returned rather than nothing. Cached for a week:
   public holiday calendars do not change hour to hour.

   COVERAGE CAVEAT: Nager.Date lists only national public holidays. For
   India that is three days a year — Republic Day, Independence Day,
   Gandhi Jayanti — with no Diwali, Dussehra, Holi or Eid, and no state
   holidays at all. So even when this endpoint works perfectly, the window
   list for India is thinner than a person's real calendar. Fixing that
   needs a curated holiday table, not a better fetch.                  */
/* Google publishes a public holiday calendar per country as an ICS feed,
   and it is far more complete than the structured APIs. Nager lists three
   holidays for India — Republic Day, Independence Day, Gandhi Jayanti — and
   omits Diwali, Dussehra, Holi, Eid and every state holiday, which for a
   traveller in Bengaluru is most of the calendar they actually get off.
   The Google feed carries all of them.

   Minimal ICS parsing: unfold continuation lines, take DTSTART/SUMMARY out
   of each VEVENT. Observances that are not days off ("Sankranti observance",
   "Restricted holiday") are dropped, because a window we build on a day the
   traveller still has to work is worse than no window. */
const GCAL = cc =>
  `https://calendar.google.com/calendar/ical/en.${GCAL_ID[cc] || ""}%23holiday%40group.v.calendar.google.com/public/basic.ics`;

// Google's feed names are not ISO codes; only countries we can name are tried.
/* Google's own published list of holiday-calendar identifiers, 207
   territories, supplied as a CSV and kept in the repo as
   Google_Calendar_Country_Strings.csv for provenance.

   This replaces a table I had written from general knowledge, which was
   wrong for at least Saudi Arabia — "sa" is SOUTH AFRICA, so cc=SA returned
   Freedom Day and Heritage Day, silently, to anyone in Riyadh.

   Cross-checked against the six countries we had verified against the live
   endpoint: South Africa, India, Egypt, Morocco, Tunisia and Iran all agree.
   Two differ from what I had guessed — Turkey ("tr" not "turkish") and
   Thailand ("thai" not "th") — and since my values demonstrably worked for
   Turkey, Google likely accepts both. The published value is used either
   way, because a sourced value beats a working guess, and the identity
   check below catches it if a name is ever stale. */
const GCAL_ID = {
  AD: "ad", AE: "ae", AF: "af", AG: "ag", AI: "ai", AL: "al", AM: "am", AO: "ao", AR: "ar",
  AT: "austrian", AU: "australian", AW: "aw", AZ: "az", BA: "ba", BB: "bb", BD: "bd",
  BE: "be", BG: "bg", BH: "bh", BI: "bi", BM: "bm", BN: "bn", BO: "bo", BR: "brazilian",
  BS: "bs", BT: "bt", BW: "bw", BY: "by", BZ: "bz", CA: "canadian", CD: "cd", CF: "cf",
  CG: "cg", CH: "ch", CI: "ci", CK: "ck", CL: "cl", CM: "cm", CN: "china", CO: "co",
  CR: "cr", CU: "cu", CV: "cv", CW: "cw", CY: "cy", CZ: "czech", DE: "german", DJ: "dj",
  DK: "danish", DM: "dm", DO: "do", DY: "bj", DZ: "dz", EC: "ec", EE: "ee", EG: "eg",
  ER: "er", ES: "spain", ET: "et", FI: "finnish", FJ: "fj", FM: "fm", FX: "french",
  GA: "ga", GB: "uk", GD: "gd", GE: "ge", GH: "gh", GI: "gi", GL: "gl", GM: "gm", GN: "gn",
  GQ: "gq", GR: "greek", GT: "gt", GW: "gw", GY: "gy", HK: "hong_kong", HN: "hn",
  HR: "croatian", HT: "ht", HU: "hungarian", HV: "bf", ID: "indonesian", IE: "irish",
  IL: "jewish", IN: "indian", IQ: "iq", IR: "ir", IS: "is", IT: "italian", JM: "jm",
  JO: "jo", JP: "japanese", KE: "ke", KG: "kg", KH: "kh", KI: "ki", KM: "km", KN: "kn",
  KR: "south_korea", KW: "kw", KY: "ky", KZ: "kz", LA: "la", LB: "lb", LC: "lc", LI: "li",
  LK: "lk", LR: "lr", LS: "ls", LT: "lt", LU: "lu", LV: "lv", LY: "ly", MA: "ma", MC: "mc",
  MD: "md", ME: "me", MG: "mg", MH: "mh", MK: "mk", ML: "ml", MM: "mm", MN: "mn", MO: "mo",
  MR: "mr", MT: "mt", MU: "mu", MV: "mv", MW: "mw", MX: "mexican", MY: "malaysia",
  MZ: "mz", NA: "na", NE: "ne", NG: "ng", NI: "ni", NL: "dutch", NO: "norwegian", NP: "np",
  NR: "nr", NZ: "new_zealand", OM: "om", PA: "pa", PE: "pe", PG: "pg", PH: "philippines",
  PK: "pk", PL: "polish", PR: "pr", PS: "ps", PT: "portuguese", PW: "pw", PY: "py",
  QA: "qa", RO: "romanian", RU: "russian", RW: "rw", SA: "saudiarabian", SB: "sb",
  SC: "sc", SD: "sd", SE: "swedish", SG: "singapore", SI: "slovenian", SK: "slovak",
  SL: "sl", SM: "sm", SN: "sn", SO: "so", SR: "sr", SS: "ss", ST: "st", SV: "sv", SY: "sy",
  SZ: "sz", TD: "td", TG: "tg", TH: "thai", TJ: "tj", TM: "tm", TN: "tn", TO: "to",
  TP: "tl", TR: "tr", TT: "tt", TV: "tv", TW: "taiwan", TZ: "tz", UA: "ua", UG: "ug",
  US: "usa", UY: "uy", UZ: "uz", VA: "va", VC: "vc", VE: "ve", VG: "vg", VN: "vietnamese",
  VU: "vu", WS: "ws", YE: "ye", YU: "rs", ZA: "sa", ZM: "zm", ZW: "zw"
};

/* Not days off, however they are labelled. "Half-day" is the one the live
   German feed exposed: Christmas Eve and New Year's Eve arrive as public
   holidays with "(half-day)" appended, and a window built on an afternoon
   is a window the traveller does not have. The "(regional holiday)" suffix
   is left alone — those ARE days off, and `counties` says where. */
const SKIP = /(not a public holiday|half[- ]day|season|day \d)/i;

/* OBSERVANCES ARE NOT NOTHING, and treating them as nothing is what made
   every Indian state show an identical calendar.

   Google's India feed carries 54 events for 2026 and marks only 18 of them
   "Public holiday". The other 36 are "Observance" — and that bucket holds
   Pongal, Onam, Ugadi, Gudi Padwa, Vaisakhi, Bihu, Ganesh Chaturthi, Chhath
   Puja and Durga Puja, which are among the largest state holidays in the
   country. It also holds Karva Chauth, Ramadan Start and Christmas Eve,
   which are days nobody gets off. Google draws one line for the whole
   country: a day is an "Observance" if it is not gazetted centrally, no
   matter that half of India closes for it.

   So the Worker stops making the call and passes them through tagged. The
   browser decides, because the browser is the only place that knows which
   state the traveller is in — and it keeps an observance ONLY where the
   curated table in waypoint-holidays.js names it as a real day off there.
   Unnamed observances are still dropped; the difference is that they are
   now dropped by something that could have known better, rather than
   thrown away two steps before anyone could look. */
const OBSERVANCE = /observance/i;

/* Restricted holidays used to be thrown away with the observances, and they
   are not the same thing. A restricted holiday IS a day off — Raksha
   Bandhan, Holi in some states — it simply has to be requested rather than
   arriving automatically. Dropping it meant a traveller in Gurgaon never
   saw a day they could very well have taken.

   So it comes through tagged instead, and the window builder charges it as
   a leave day. The traveller sees the day and is told what it costs, which
   is the honest version of both. */
const RESTRICTED = /restricted holiday/i;

/* Does this calendar say it is the country we asked for?

   Every Google holiday ICS carries an X-WR-CALNAME header naming itself —
   "Holidays in India", "Holidays in South Africa". That is the feed's own
   statement of identity, and checking it catches a misaddressed calendar
   directly, without needing a second source to compare dates against.

   This is what was missing when cc=SA returned South Africa: the feed was
   announcing "Holidays in South Africa" in its own header the whole time
   and nothing read it. It matters most for the twenty countries Nager does
   not cover — India among them — where no date cross-check is possible. */
const CAL_ALIAS = {
  AE: ["united arab emirates", "uae"], GB: ["united kingdom", "uk", "britain"],
  US: ["united states", "usa", "u.s."], KR: ["south korea", "korea"],
  TR: ["turkey", "turkiye", "türkiye"], CZ: ["czechia", "czech republic"],
  MM: ["myanmar", "burma"], LA: ["laos", "lao"], MO: ["macau", "macao"],
  HK: ["hong kong"], VN: ["vietnam", "viet nam"], RU: ["russia"],
  IR: ["iran"], SY: ["syria"], VE: ["venezuela"], BO: ["bolivia"],
  /* Google's published list gives Israel the "jewish" calendar, whose
     X-WR-CALNAME is "Jewish Holidays" — it names a religion, not the
     country. Sourced, so trusted; aliased so the identity check does not
     reject it. This is the one place the check needs telling. */
  IL: ["israel", "jewish"],
  TZ: ["tanzania"], MD: ["moldova"], MK: ["north macedonia", "macedonia"]
};

function calNameMatches(calName, cc) {
  if (!calName) return null;                       // header absent: can't tell
  const norm = x => String(x).toLowerCase()
    .replace(/holidays?\s+(in|of)\s+/g, "")
    .replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  const got = norm(calName);
  if (!got) return null;
  let names = CAL_ALIAS[cc] || [];
  try {
    const disp = new Intl.DisplayNames(["en"], { type: "region" }).of(cc);
    if (disp) names = names.concat([disp]);
  } catch { /* fall through to aliases alone */ }
  if (!names.length) return null;
  return names.some(n => { const w = norm(n); return w && (got.includes(w) || w.includes(got)); });
}

/* Returns { calName, events }. An earlier version hung `calName` off the
   returned array as a property — legal JavaScript, but arrays are not
   records, and every reader of it got flagged. A pair says what it means. */
function parseICS(text, years) {
  const out = [];
  const cm = /^X-WR-CALNAME:(.+)$/m.exec(text.replace(/\r\n[ \t]/g, ""));
  const calName = cm ? cm[1].trim() : null;
  // Unfold: a line beginning with a space continues the previous one.
  const lines = text.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
  let cur = null;
  for (const ln of lines) {
    // Shaped rather than empty: `cur = {}` makes editors infer the type as
    // `{}` and then flag every field access on it. Same behaviour, no noise.
    /* Declared with every field it will ever have. The old three-field
       literal meant `cur.restricted = true` was assigning to a property the
       editor could prove did not exist, which is the two warnings that were
       showing in the Cloudflare editor. Same behaviour, no complaints. */
    if (ln === "BEGIN:VEVENT") {
      cur = { date: "", name: "", desc: "", restricted: false, observance: false };
      continue;
    }
    if (ln === "END:VEVENT") {
      if (cur && cur.date && cur.name && !SKIP.test(cur.name) && !SKIP.test(cur.desc || "")) {
        if (RESTRICTED.test(cur.name) || RESTRICTED.test(cur.desc || "")) cur.restricted = true;
        if (OBSERVANCE.test(cur.desc || "")) cur.observance = true;
        const y = +cur.date.slice(0, 4);
        /* Same shape as the Nager entries below, with null meaning "this
           source doesn't know". Without the fields the merge below reads
           them off a narrower type, and editors flag it. null rather than
           false because unknown is not the same as "not national" — false
           here would let the calendar feed overrule Nager's own answer. */
        if (years.includes(y)) out.push({ date: cur.date, localName: cur.name,
          name: cur.name, global: null, counties: null,
          restricted: !!cur.restricted, observance: !!cur.observance });
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const m = /^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})/.exec(ln);
    if (m) { cur.date = `${m[1]}-${m[2]}-${m[3]}`; continue; }
    if (ln.startsWith("SUMMARY:")) { cur.name = ln.slice(8).replace(/\\,/g, ",").trim(); continue; }
    if (ln.startsWith("DESCRIPTION:")) { cur.desc = ln.slice(12); }
  }
  return { calName, events: out };
}

async function holidays(request, ctx) {
  const u = new URL(request.url);
  const cc = cleanToken(u.searchParams.get("cc"), 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return json({ error: "cc must be a 2-letter country code" }, 400);

  const now = new Date().getFullYear();
  const years = cleanToken(u.searchParams.get("years"), 24).split(",")
    .map(x => parseInt(x, 10)).filter(y => y >= now - 1 && y <= now + 2);
  if (!years.length) years.push(now, now + 1);

  /* DIAGNOSTIC ONLY, reached with &debug=1. Returns every event the Google
     feed carries for these years with the DESCRIPTION line Google uses to
     say what kind of day it is, so decisions about which festivals are real
     days off can be made against what the feed actually says rather than
     from memory. Nothing in the app calls this. */
  const dbg = u.searchParams.get("debug");
  if (dbg) {
    if (!GCAL_ID[cc]) return json({ cc, error: "no google calendar id" }, 200);
    const dr = await fetch(GCAL(cc), { headers: { "User-Agent": "Waypoint/1.0" } });
    if (!dr.ok) return json({ cc, error: "gcal:" + dr.status }, 200);
    const rawText = await dr.text();
    /* Parsed here rather than read from the `calName` further down this
       function. That one is declared with `let` about eighty lines below,
       so reading it from up here is a temporal-dead-zone ReferenceError —
       which Cloudflare reports only as "Error 1101, Worker threw exception"
       and which `node --check` cannot see, because it is a runtime fault
       rather than a syntax one. */
    const dbgCal = (/^X-WR-CALNAME:(.+)$/m
      .exec(rawText.replace(/\r\n[ \t]/g, "")) || [, null])[1];

    /* debug=raw — the feed exactly as Google sends it, unparsed. Served as
       text/plain so a browser displays it instead of offering a download.
       This is the whole file; for India it runs to a few thousand lines. */
    if (dbg === "raw")
      return new Response(rawText, { status: 200, headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store" } });

    /* debug=fields — a census of every ICS property present, with how often
       each appears and an example value, plus the calendar-level headers and
       three complete VEVENTs verbatim.

       This is the question "what can we possibly get from Google" answered
       by counting rather than by recollection. If a property carrying
       geography or subdivision existed anywhere in the feed, it would show
       up here — which is the point of running it. */
    if (dbg === "fields") {
      const flat = rawText.replace(/\r\n[ \t]/g, "");
      const headers = [];
      const props = {};
      let inEvent = false, events = 0;
      const samples = [], cur = [];
      for (const ln of flat.split(/\r?\n/)) {
        if (ln === "BEGIN:VEVENT") { inEvent = true; events++; cur.length = 0; cur.push(ln); continue; }
        if (ln === "END:VEVENT") {
          inEvent = false; cur.push(ln);
          if (samples.length < 3) samples.push(cur.join("\n"));
          continue;
        }
        if (!inEvent) {
          const hm = /^([A-Z][A-Z0-9-]*)[:;]/.exec(ln);
          if (hm && !/^(BEGIN|END)$/.test(hm[1])) headers.push(ln);
          continue;
        }
        cur.push(ln);
        const m = /^([A-Z][A-Z0-9-]*)[:;]/.exec(ln);
        if (!m) continue;
        const k = m[1];
        if (!props[k]) props[k] = { count: 0, example: ln.slice(0, 160) };
        props[k].count++;
      }
      return json({ cc, events,
        calendarHeaders: headers,
        eventProperties: Object.keys(props).sort().map(k => ({
          property: k, appearsIn: props[k].count + " of " + events,
          example: props[k].example })),
        sampleEvents: samples }, 200, { "Cache-Control": "no-store" });
    }

    /* debug=names — EVERY distinct holiday name in the feed, across every
       year the feed carries, with its spelling variants, the years it
       appeared in, and which category Google filed it under.

       This is the input to the curated state table. Two things make it the
       right starting point rather than a general list of the country's
       holidays. It is drawn from the same feed the app filters, so the
       names match exactly — a table keyed on "Chhath Puja" is useless when
       the feed says "Chhat Puja". And it groups spelling variants across
       years, which is how "Bohag Bihu" and "Bahag Bihu" turn out to be one
       holiday rather than two.

       The year clamp elsewhere in this endpoint does not apply here: this
       deliberately reads the entire published range, and reports what that
       range turned out to be. */
    if (dbg === "names") {
      const flat = rawText.replace(/\r\n[ \t]/g, "");
      const key = s => s.toLowerCase().replace(/\(.*?\)/g, "")
        .replace(/[^a-z0-9]/g, "");
      const seen = new Map();
      let c = null;
      for (const ln of flat.split(/\r?\n/)) {
        if (ln === "BEGIN:VEVENT") { c = { date: "", name: "", desc: "" }; continue; }
        if (ln === "END:VEVENT") {
          if (c && c.date && c.name) {
            const k = key(c.name);
            if (!seen.has(k)) seen.set(k, { variants: new Set(), years: new Set(),
                                            categories: new Set(), count: 0 });
            const e = seen.get(k);
            e.variants.add(c.name);
            e.years.add(c.date.slice(0, 4));
            e.categories.add((/^[^\\]*/.exec(c.desc) || [""])[0].trim() || "(none)");
            e.count++;
          }
          c = null; continue;
        }
        if (!c) continue;
        const dm = /^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})/.exec(ln);
        if (dm) { c.date = `${dm[1]}-${dm[2]}-${dm[3]}`; continue; }
        if (ln.startsWith("SUMMARY:")) { c.name = ln.slice(8).replace(/\\,/g, ",").trim(); continue; }
        if (ln.startsWith("DESCRIPTION:")) { c.desc = ln.slice(12).trim(); }
      }
      const all = [...seen.values()].flatMap(e => [...e.years]).sort();
      /* Exact normalisation will not merge "Bohag Bihu" and "Bahag Bihu" —
         one letter apart, two rows. Fuzzy-merging them automatically would
         be worse, because it would also merge genuinely different holidays
         that happen to look alike. So they stay separate and get a hint
         instead: names sharing a consonant skeleton are flagged as likely
         spellings of each other, for a human to confirm or reject. It
         catches vowel drift, which is nearly all of the drift there is in
         transliterated names. It will not catch true aliases like
         Diwali/Deepavali, which have to be spotted by knowing them. */
      const skel = k => k.replace(/[aeiou]/g, "");
      const bySkel = {};
      for (const k of seen.keys()) (bySkel[skel(k)] ||= []).push(k);
      const rows = [...seen.entries()].map(([k, e]) => ({
        key: k,
        variants: [...e.variants].sort(),
        likelySameAs: (bySkel[skel(k)] || []).filter(x => x !== k),
        categories: [...e.categories].sort(),
        years: [...e.years].sort(),
        occurrences: e.count
      })).sort((a, b) => a.variants[0] < b.variants[0] ? -1 : a.variants[0] > b.variants[0] ? 1 : 0);
      return json({ cc, calName: dbgCal ? dbgCal.trim() : null,
        yearsInFeed: all.length ? `${all[0]}–${all[all.length - 1]}` : "none",
        distinctNames: rows.length, names: rows }, 200,
        { "Cache-Control": "no-store" });
    }

    /* debug=coverage — the one call that answers "is Nager good enough yet,
       or is there still work to do here?"

       Only 31 of the 250 countries in the python-holidays dataset have any
       regional holiday variation at all; 215 have no subdivisions
       whatsoever. Those 31 are the entire scope of this problem, so they
       are the list checked below. For each, this reports whether Nager
       covers the country, how many holidays it returns, and — the number
       that actually matters — how many of those carry subdivision codes.

       A country showing holidays but ZERO with subdivisions is the failure
       mode to watch for: Nager "covers" it, so nothing looks wrong, but
       every regional holiday is being shown to everyone in the country.
       Those are the ones that would need a curated table, the way India
       does. A country with a healthy subdivision count needs nothing from
       us beyond the region centres in waypoint-holidays.js.

       Roughly thirty subrequests, comfortably inside the Workers limit. */
    if (dbg === "coverage") {
      /* How many DISTINCT DATES in a year are regional rather than national,
         per country, measured offline against the python-holidays dataset.
         Embedded because the verdict is meaningless without it.

         The first version of this endpoint called any country with at least
         one subdivision-tagged holiday "nothing to do", and that was far too
         lenient — it passed the United States on 6 tagged dates against 57
         that exist, Brazil on 1 against 41, Italy on 1 against 90. All three
         look covered and are effectively untagged. */
      const EXPECTED = { IN:54, US:57, CH:22, BA:15, MY:43, AU:16, FM:20, AR:38, ES:27,
        CA:13, BR:41, DE:11, GB:9, ST:5, FR:17, AD:14, BT:4, IT:90, CV:23, PT:19, SB:11,
        TV:10, BQ:6, SH:3, NI:2, SV:2, NZ:11, BO:9, CL:2, FI:1, GQ:1 };
      const yr = new Date().getFullYear();
      let available = [];
      try {
        const ar = await fetch("https://nagerholidays.com/api/v4/Countries/Available");
        if (ar.ok) available = (await ar.json()).map(x => x.countryCode);
      } catch { /* leave empty; the per-country probe still tells us most of it */ }
      const out = [];
      for (const k of Object.keys(EXPECTED)) {
        let n = 0, withSub = 0, err = null;
        try {
          const r = await fetch(`https://nagerholidays.com/api/v4/Holidays/${k}/${yr}`);
          if (r.ok) {
            /* An empty BODY, not an empty array — Nager answers 200 with
               nothing in it for countries it does not have, so JSON.parse
               throws. That is "not covered", not an error, and reporting it
               as an error is how India and Malaysia stayed off the needs-work
               list on the first run. */
            const text = await r.text();
            const list = text.trim() ? JSON.parse(text) : [];
            if (Array.isArray(list)) {
              n = list.length;
              withSub = list.filter(h => Array.isArray(h.subdivisionCodes)
                && h.subdivisionCodes.length).length;
            }
          } else err = "http:" + r.status;
        } catch (e) { err = String(e.message || e).slice(0, 60); }
        const exp = EXPECTED[k];
        const verdict = err ? "error: " + err
          : n === 0 ? "NOT COVERED — Nager has nothing for this country"
          : exp === 0 ? "no regional holidays to tag"
          : withSub === 0 ? "GAP — covered, but not one holiday carries a subdivision"
          : withSub < exp * 0.5 ? `THIN — ${withSub} tagged against ${exp} regional dates`
          : "ok — enough subdivision data to scope from";
        out.push({ cc: k, listed: available.length ? available.includes(k) : null,
                   holidays: n, withSubdivisions: withSub, regionalDatesExpected: exp,
                   verdict, error: err });
      }
      const needs = out.filter(x => /^(NOT COVERED|GAP|THIN)/.test(x.verdict)).map(x => x.cc);
      return json({ checkedYear: yr, nagerCountryCount: available.length,
        needsWork: needs, needsWorkCount: needs.length,
        ok: out.filter(x => x.verdict.startsWith("ok")).map(x => x.cc),
        countries: out }, 200, { "Cache-Control": "no-store" });
    }

    /* debug=nager — is this country's regional data a solved problem or a
       curated one? Nager publishes ISO 3166-2 subdivisions per holiday for
       the countries it covers, and covers nothing at all for the rest.
       Which bucket a country falls into decides whether a hand-written
       table is needed, so it is worth being able to check rather than
       assume. Reports what Nager has for this country and, for the whole
       picture, which of our calendar countries Nager does not reach. */
    if (dbg === "nager") {
      const yr = new Date().getFullYear();
      let list = null, err = null;
      try {
        const nr = await fetch(`https://nagerholidays.com/api/v4/Holidays/${cc}/${yr}`);
        if (nr.ok) list = await nr.json(); else err = "http:" + nr.status;
      } catch (e) { err = String(e); }
      let available = [];
      try {
        const ar = await fetch("https://nagerholidays.com/api/v4/Countries/Available");
        if (ar.ok) available = (await ar.json()).map(x => x.countryCode);
      } catch { /* leave empty */ }
      const subsOf = h => (Array.isArray(h.subdivisionCodes) && h.subdivisionCodes.length)
        ? h.subdivisionCodes : (Array.isArray(h.counties) ? h.counties : []);
      const withSubs = Array.isArray(list) ? list.filter(h => subsOf(h).length) : [];
      return json({ cc, year: yr,
        nagerCovers: available.includes(cc),
        nagerHolidays: Array.isArray(list) ? list.length : 0,
        nagerError: err,
        holidaysWithSubdivisions: withSubs.length,
        subdivisionExample: withSubs[0] || null,
        nagerCountryCount: available.length,
        calendarCountriesNagerLacks: Object.keys(GCAL_ID)
          .filter(k => available.length && !available.includes(k)).sort()
      }, 200, { "Cache-Control": "no-store" });
    }

    const dl = rawText.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
    const ev = []; let c = null;
    for (const ln of dl) {
      if (ln === "BEGIN:VEVENT") { c = { date: "", name: "", desc: "" }; continue; }
      if (ln === "END:VEVENT") {
        if (c && c.date && years.includes(+c.date.slice(0, 4)))
          ev.push({ date: c.date, summary: c.name, description: c.desc,
                    dropped: SKIP.test(c.name) || SKIP.test(c.desc),
                    observance: OBSERVANCE.test(c.desc) });
        c = null; continue;
      }
      if (!c) continue;
      const dm = /^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})/.exec(ln);
      if (dm) { c.date = `${dm[1]}-${dm[2]}-${dm[3]}`; continue; }
      if (ln.startsWith("SUMMARY:")) { c.name = ln.slice(8).replace(/\\,/g, ",").trim(); continue; }
      if (ln.startsWith("DESCRIPTION:")) { c.desc = ln.slice(12).trim(); }
    }
    return json({ cc, years, total: ev.length, kept: ev.filter(e => !e.dropped).length,
      events: ev.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0) }, 200,
      { "Cache-Control": "no-store" });
  }

  /* v4, not v3. The cache holds a week of the OLD results, and without
     bumping this every visitor would keep getting them until they expired —
     the deploy would look like it had done nothing. Bump on every change to
     what this endpoint returns. */
  const key = new Request(`https://waypoint.cache/holidays/v4/${cc}/${years.join("-")}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  const failed = [];
  const sources = [];
  let gcal = [], nager = [];
  let calName = null, identity = null;

  /* WHY THESE NOW RUN AT THE SAME TIME.

     Google's calendar and Nager are independent sources that never consult
     each other, so fetching one and then the other only ever added the two
     latencies together. They are started together now and awaited once.

     The Nager probe is the reason this mattered. It walked two hosts and
     two API versions for each of two years, one request at a time, and
     stopped only when something answered. For a country Nager covers that
     is one request and the loop never gets going. For a country it does
     NOT cover — India among roughly sixty others — every one of the eight
     combinations was tried, in series, and every one returned an empty
     body. Eight round trips to learn nothing, on every cache miss, in front
     of the one feature the homepage is built on.

     Three changes: the years run concurrently, every probe has a deadline
     so a hanging host cannot stall the response, and a country with no
     Nager coverage is REMEMBERED at the edge for a month so the discovery
     is made once rather than on every miss. */

  // 1 · Google's calendar: broad, includes regional and religious holidays.
  const gcalJob = (async () => {
    if (!GCAL_ID[cc]) return;
    try {
      const r = await raced(fetch(GCAL(cc), { headers: { "User-Agent": "Waypoint/1.0" } }), 8000);
      if (r.ok) {
        const parsed = parseICS(await r.text(), years);
        gcal = parsed.events;
        calName = parsed.calName;
        identity = calNameMatches(calName, cc);
        // The feed named a different country. Believe it, and drop it.
        if (identity === false) {
          failed.push(`gcal:wrong-country (feed says "${calName}")`);
          gcal = [];
        }
      } else failed.push(`gcal:${r.status}`);
    } catch (e) { failed.push(`gcal:${String(e.message || e).slice(0, 40)}`); }
  })();

  /* 2 · Nager: fewer entries than the calendar, but authoritative on what is
        a national day off and on which subdivisions observe a regional one.
        Each year is isolated so one failure cannot empty the other.

     V4 FIRST, V3 AS FALLBACK, AND A NEW HOST. Nager has moved its canonical
     address to nagerholidays.com and published a v4 API; date.nager.at still
     answers, but building on the address a project is migrating away from is
     borrowing trouble. Both are tried, in that order, so a retirement of
     either does not take holidays down.

     What v4 changes, and why it is worth the migration:

       counties      -> subdivisionCodes, in FULL ISO 3166-2 form ("DE-BY"
                        rather than "BY"). E.scopeHolidays normalises both
                        ends now, so either shape works, but the full form
                        is unambiguous across countries.
       global        -> nationalHoliday
       types         -> holidayTypes, an enum of Public, Bank, School,
                        Authorities, Optional and Observance.

     That last one is the real gain. v3 gave no way to tell a day everyone
     gets off from one that has to be applied for, so every Nager entry was
     treated as free. "Optional" now maps to our `restricted` flag, which
     makes the window builder charge it as leave, and "Observance" maps to
     the same guilty-until-named handling as Google's observances.

     What v4 takes away is `localName` — it returns English only. Names come
     from the calendar feed for most countries anyway, and where they do not,
     an English name is a smaller loss than a mis-costed holiday. */
  const nagerHosts = ["https://nagerholidays.com", "https://date.nager.at"];
  const NAGER_SKIP = new Set(["School"]);          // schools shut, offices do not

  /* Has this country already been shown to have no Nager data at all? The
     note is deliberately separate from the holiday cache: it is a fact about
     the country rather than about a particular pair of years, and it lasts a
     month rather than a week. */
  const noCoverKey = new Request(`https://waypoint.invalid/nager-empty?cc=${cc}`);
  let skipNager = false;
  try { skipNager = !!(await cache.match(noCoverKey)); } catch (e) { /* no cache, probe anyway */ }
  if (skipNager) failed.push("nager:skipped (no coverage, remembered)");

  /* Returns { list, outcome }. `outcome` matters: "empty" means every host
     answered properly and had nothing, which is a real fact about the
     country. "error" means we could not tell. Only the first is worth
     remembering, or a five-minute Nager outage would cost Germany its
     subdivision data for a month. */
  const nagerYear = async (y) => {
    let sawEmpty = false, sawError = false;
    for (const host of nagerHosts) {
      for (const ver of ["v4", "v3"]) {
        const url = ver === "v4"
          ? `${host}/api/v4/Holidays/${cc}/${y}`
          : `${host}/api/v3/PublicHolidays/${y}/${cc}`;
        try {
          const r = await raced(
            fetch(url, { headers: { "User-Agent": "Waypoint/1.0 (travel planner)" } }), 4000);
          if (!r.ok) {
            failed.push(`nager:${ver}:${y}:${r.status}`);
            // 404 is Nager's honest "I do not have this", not a fault.
            if (r.status === 404) sawEmpty = true; else sawError = true;
            continue;
          }
          const list = await r.json();
          if (!Array.isArray(list) || !list.length) {
            failed.push(`nager:${ver}:${y}:empty`); sawEmpty = true; continue;
          }
          sources.push(`nager:${ver}`);
          return { list, outcome: "ok" };
        } catch (e) {
          failed.push(`nager:${ver}:${y}:${String(e.message || e).slice(0, 40)}`);
          sawError = true;
        }
      }
    }
    return { list: null, outcome: sawError || !sawEmpty ? "error" : "empty" };
  };

  const results = await Promise.all([
    gcalJob,
    ...(skipNager ? [] : years.map(nagerYear))
  ]);
  const nagerResults = results.slice(1);

  for (const res of nagerResults) {
    if (!res || !res.list) continue;
    for (const h of res.list) {
      const kinds = Array.isArray(h.holidayTypes) ? h.holidayTypes
                  : Array.isArray(h.types) ? h.types : [];
      if (kinds.length && kinds.every(t => NAGER_SKIP.has(t))) continue;
      const subs = Array.isArray(h.subdivisionCodes) && h.subdivisionCodes.length
        ? h.subdivisionCodes
        : (Array.isArray(h.counties) && h.counties.length ? h.counties : null);
      nager.push({
        date: h.date,
        localName: h.localName || h.name,
        name: h.name,
        observance: kinds.includes("Observance"),
        restricted: kinds.includes("Optional"),
        global: h.nationalHoliday != null ? !!h.nationalHoliday : h.global !== false,
        // Left in whatever form the API gave; the browser strips the
        // country prefix at comparison time, so both shapes match.
        counties: subs
      });
    }
  }

  /* Remember "no coverage" only when every probe answered cleanly and had
     nothing, and only when the calendar gave us a usable list anyway — so a
     country that fails both sources is retried in full next time rather
     than written off. */
  if (!skipNager && !nager.length && gcal.length &&
      nagerResults.length && nagerResults.every(r => r && r.outcome === "empty")) {
    try {
      ctx.waitUntil(cache.put(noCoverKey,
        new Response("1", { headers: { "Cache-Control": "public, max-age=2592000" } })));
    } catch (e) { /* caching is an optimisation, never a requirement */ }
  }

  /* CROSS-CHECK. The calendar identifiers are names, not country codes, so a
     wrong one does not fail — it quietly returns a different country. Asking
     for Saudi Arabia returned South Africa's Freedom Day and Heritage Day,
     and nothing anywhere said so.

     Two calendars for the same country always share some dates: fixed
     national days, or Christmas and New Year at minimum. Zero overlap means
  /* Second check, where a second source exists. Two calendars for the same
     country always share some dates. Zero overlap means they disagree about
     which country this is, and Nager — keyed by ISO code, impossible to
     misaddress — wins. Where Nager has no coverage there is nothing to
     compare against, and `verified` stays as the identity header left it. */
  let verified = identity;
  if (gcal.length && nager.length) {
    const nagerDates = new Set(nager.map(h => h.date));
    const shared = gcal.filter(h => nagerDates.has(h.date)).length;
    if (!shared) {
      failed.push(`gcal:date-mismatch (0 of ${gcal.length} dates match nager)`);
      gcal = [];
      verified = false;
    } else if (verified !== false) verified = true;
  }

  /* No combined array any more: the merge below reads the two sources
     separately because it treats them differently — the calendar supplies
     the holidays, Nager annotates them. */
  if (gcal.length) sources.push("google-calendar");
  // The version actually used was already pushed above, so this only needs
  // to guard against the array ending up empty or duplicated.
  if (nager.length && !sources.some(x => x.startsWith("nager"))) sources.push("nager");

  /* RECONCILE THE TWO SOURCES WITHOUT COLLAPSING A DATE.

     The old version kept exactly one entry per date. That is right for
     reconciling two calendars that describe the same day — Google says
     "Epiphany (regional holiday)", Nager says "Heilige Drei Könige", one
     holiday, two names, and the merge is how Nager's subdivision list
     reaches Google's better name.

     It is wrong for a country where one date genuinely holds several
     different holidays observed by different people. India is full of
     them: 14 January is Pongal in Tamil Nadu and Makar Sankranti in
     Karnataka, 19 March is Gudi Padwa in Maharashtra and Ugadi in
     Karnataka, 14 April is Vaisakhi in Punjab and Ambedkar Jayanti
     everywhere. Keying on the date alone threw away all but one of each
     pair before the browser could see them, which defeated the entire
     point of the per-state table in waypoint-holidays.js — it was being
     handed a list with the regional entries already deleted.

     So: distinct (date, name) pairs from the calendar all survive, and
     Nager is used to ENRICH them rather than to compete with them. Where
     Nager names a date the calendar already has, its `global` and
     `counties` are copied onto the real holidays there and its own entry
     is not added again. Where Nager names a date the calendar missed, it
     is added. Observances are deliberately excluded from enrichment: a
     day off and a day merely noted can share a date, and Nager's "this is
     national" must not leak onto the one that isn't. */
  const nameKey = s => String(s || "").toLowerCase()
    .replace(/\(.*?\)/g, "").replace(/[^a-z]/g, "");
  const byKey = new Map();
  const add = h => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date || "")) return;
    const k = h.date + "|" + nameKey(h.localName || h.name);
    if (!byKey.has(k)) byKey.set(k, { ...h });
  };
  for (const h of gcal) add(h);
  for (const h of nager) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date || "")) continue;
    const sameDay = [...byKey.values()].filter(x => x.date === h.date && !x.observance);
    if (!sameDay.length) { add(h); continue; }
    for (const x of sameDay) {
      if (h.counties && !x.counties) x.counties = h.counties;
      if (h.global != null && x.global == null) x.global = h.global;
      if ((h.localName || "").length > (x.localName || "").length) x.localName = h.localName;
    }
  }
  const merged = [...byKey.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  // Never cache an empty result: that would pin a transient outage for a week.
  const body = json({ cc, years, holidays: merged, count: merged.length,
    observances: merged.filter(h => h.observance).length,
    sources, verified, calName, failed },
    200, { "Cache-Control": merged.length ? "public, max-age=600, s-maxage=604800" : "no-store" });
  if (merged.length) ctx.waitUntil(cache.put(key, body.clone()));
  return body;
}


/* ── HEALTH ─────────────────────────────────────────────────────────
   Open your Worker URL in a browser and this tells you, in plain
   words, whether the AI is actually wired up.                        */
async function health(env) {
  const hasClaude = !!env.ANTHROPIC_API_KEY;
  const hasWorkersAI = !!env.AI;
  const hasKV = !!env.RATE;
  let aiReply = null, aiError = null;
  if (hasClaude || hasWorkersAI) {
    try {
      const r = await runModel(env, 'Reply with exactly: PONG', 20);
      aiReply = asText(r).trim().slice(0, 40);
    } catch (e) { aiError = String(e && e.message || e); }
  }
  const working = !!aiReply;
  return json({
    service: "waypoint-api",
    /* Bump this whenever you deploy. If the number you see here isn't the
       number in the file you just edited, the deploy didn't take — which is
       exactly how /api/ready-link came to be routed to a function that
       wasn't in the bundle. */
    build: "v27-context-routing",
    /* true when this Worker is also serving the website (wrangler.jsonc). */
    servesSite: !!env.ASSETS,
    endpoints: { readyLink: typeof readyLink === "function" },
    ai: {
      configured: hasClaude ? "claude" : hasWorkersAI ? "workers-ai" : "none",
      working,
      testReply: aiReply,
      error: aiError,
      verdict: working
        ? `AI is working — briefings will appear on your results page (model: ${hasClaude ? "claude" : "workers-ai"})`
        : hasClaude || hasWorkersAI
          ? "A model is bound but the test call failed — see error above"
          : "No model bound. Add a Workers AI binding named AI, or an ANTHROPIC_API_KEY secret."
    },
    /* AFFILIATES — the reminder that keeps the disclosure honest.

       The page's commission note is a hand-flipped switch in
       waypoint-config.js, which means it can drift out of step with what
       is actually set here. This block exists so the drift is visible at
       the exact moment it would happen: setting a partner ID and opening
       this page are the same task.

       Nothing here reveals a partner ID — only whether one exists. */
    affiliates: (() => {
      /* A template that /api/ready-link would ignore does not earn, so it
         does not count as live here either — but it is named below, so a
         typo is found in seconds rather than after a month of nothing. */
      const T = name => templateUsable(env[name]);
      const vars = {
        flights:      !!env.SKYSCANNER_MEDIA_PARTNER_ID || T("SKYSCANNER_DEEPLINK"),
        accommodation:!!env.BOOKING_AID || T("BOOKING_DEEPLINK"),
        activities:   !!env.VIATOR_PID  || T("VIATOR_DEEPLINK"),
        tours:        T("TOURRADAR_DEEPLINK"),
        cars:         !!env.DISCOVER_CARS_AFFILIATE_URL || T("KAYAK_DEEPLINK"),
        esim:         T("AIRALO_DEEPLINK"),
        transfers:    T("ROME2RIO_DEEPLINK"),
        money:        T("WISE_DEEPLINK"),
        chinaHotels:  T("TRIPCOM_DEEPLINK")
      };
      const live = Object.keys(vars).filter(k => vars[k]);
      const TEMPLATES = ["SKYSCANNER_DEEPLINK","BOOKING_DEEPLINK","VIATOR_DEEPLINK",
        "TOURRADAR_DEEPLINK","KAYAK_DEEPLINK","AIRALO_DEEPLINK","ROME2RIO_DEEPLINK",
        "WISE_DEEPLINK","TRIPCOM_DEEPLINK"];
      const ignored = TEMPLATES.filter(n => env[n] && !templateUsable(env[n]));
      const doubled = [
        ["SKYSCANNER_MEDIA_PARTNER_ID","SKYSCANNER_DEEPLINK"],
        ["BOOKING_AID","BOOKING_DEEPLINK"],
        ["VIATOR_PID","VIATOR_DEEPLINK"]
      ].filter(([a,b]) => env[a] && env[b]).map(([a,b]) => `${a} is set, so ${b} is ignored`);
      return {
        configured: vars,
        liveCount: live.length,
        problems: [
          ...ignored.map(n => `${n} is set but IGNORED — it must start with https:// and contain {url}. `
            + `Those links are going out untracked until it is fixed.`),
          ...doubled
        ],
        tagging: (env.BOOKING_LABEL || "").includes("{subid}")
          || (env.VIATOR_CAMPAIGN || "").includes("{subid}")
          ? "reporting tags in use — commission reports will break down by category and destination"
          : "no {subid} placeholder found in BOOKING_LABEL or VIATOR_CAMPAIGN. Links still earn, but every "
            + "commission arrives as one undifferentiated number and the routing work later has nothing to go on.",
        verdict: live.length
          ? `EARNING ON: ${live.join(", ")}. CHECK THE DISCLOSURE IS SHOWING. Set `
            + `WP.UI.affiliateNoticeVisible = true in waypoint-config.js and push, then load a results page and `
            + `look under the booking links. Monetised links without a visible disclosure is the one thing here `
            + `regulators act on.`
          : "No partner IDs set, so no link on the site earns anything. The commission note is correctly "
            + "switched off in waypoint-config.js. Switch it back on BEFORE setting the first ID, not after."
      };
    })(),
    /* REGIONAL ROUTING — what is switched on, and the switches to turn
       it off. Every route falls back to the default partner by itself;
       these are for when a partner changes its site after launch. */
    routing: (() => {
      const off = String(env.ROUTING_OFF||"").trim().toLowerCase()==="true";
      const skip = String(env.ROUTING_SKIP||"").toLowerCase().split(/[\s,;]+/).filter(Boolean);
      const cities = Object.keys(TRIPCOM_CITY);
      const state = name => off ? "off (ROUTING_OFF)" : skip.includes(name) ? "off (ROUTING_SKIP)" : "on";
      return {
        master: off ? "OFF — every link goes to its default partner" : "on",
        routes: {
          tripcom: `${state("tripcom")} — China hotels → Trip.com for ${cities.length} confirmed `
            + `cit${cities.length===1?"y":"ies"} (${cities.join(", ")}); every other Chinese city → Booking.com`,
          wise:    `${state("wise")} — card page chosen by the traveller's home country`
        },
        howToSwitchOff: "Cloudflare → Workers & Pages → waypoint → Settings → Variables. "
          + "ROUTING_OFF = true turns all of it off; ROUTING_SKIP = tripcom (or a comma list) turns off named "
          + "partners. Takes effect on the next click, no deploy."
      };
    })(),
    rateLimit: {
      burst: env.BURST ? "ON — Cloudflare rate limiter, per visitor per minute" : "off — no BURST binding",
      durable: hasKV,
      note: hasKV ? "Per-visitor daily count held in KV; whole-site count per location" : "Counted per edge location. Bind a KV namespace named RATE to make it global.",
      perIpPerDay: LIMITS.perIpPerDay, globalPerDay: LIMITS.globalPerDay
    },
    reputation: {
      foundation: "Wikipedia pageviews (attention) + OpenStreetMap counts (supply) + Wikivoyage (narrative). Free, keyless, cached 14d.",
      tripadvisor: "removed — the legacy Content API sunset on 2026-08-31 and the adapter was "
        + "deleted rather than migrated to Terra. TRIPADVISOR_KEY is ignored if set.",
      googlePlaces: env.GOOGLE_PLACES_KEY
        ? "ON — metered by Google. Billing must be enabled on your project."
        : "off — optional. Set GOOGLE_PLACES_KEY to enable (pay-as-you-go with free monthly caps).",
      verdict: env.GOOGLE_PLACES_KEY
        ? "Traveller ratings available."
        : "No commercial review source configured, so there are no star ratings — Waypoint runs on attention and supply signals alone, and says so on the page."
    },
    liveData: {
      fx: "ECB reference rates via Frankfurter, cached 24h",
      prices: "World Bank price level index (PA.NUS.PPPC.RF) + US CPI, cached 30d",
      climate: "ERA5 percentile climatology, rolling 15-year window, cached 30d",
      live: "Open-Meteo forecast + CAMS air quality + GDACS + USGS earthquakes",
      wildfires: env.FIRMS_MAP_KEY
        ? "NASA FIRMS active-fire detections enabled"
        : "NASA FIRMS off — set FIRMS_MAP_KEY to switch on active-fire data (free key)"
    },
    originLock: ALLOWED_ORIGINS.includes("*")
      ? "OPEN — anyone can call this. Put your Pages URL in ALLOWED_ORIGINS."
      : ALLOWED_ORIGINS.join(", ")
  }, 200, { "Cache-Control": "no-store" });
}

/* ── METERING ───────────────────────────────────────────────────────
   Three layers, chosen around the free plan's limits.

   1. BURST — Cloudflare's rate limiting binding (env.BURST, configured in
      wrangler.jsonc). A handful of calls per minute per visitor. It needs
      no storage and uses no quota, so it keeps working however busy the
      day gets. This is what actually stops a script hammering the API.

   2. PER VISITOR PER DAY — KV when it is bound (env.RATE), so the count
      holds across locations. ONE write per metered call. The free plan
      allows 1,000 KV writes a day for the whole account; if that runs
      out the write fails quietly, the visitor is still served, and layer
      1 still holds. It used to write TWO keys per call, one of them the
      same key from every visitor, which KV refuses more than once a
      second — so under load the global count silently stopped counting.

   3. WHOLE SITE PER DAY — counted in memory, per location. Deliberately
      not in KV, for the reason above. It is a soft ceiling.

   What guarantees there is no bill: on the Workers Free plan, Workers AI
   stops at its free daily allowance and cannot charge. If
   ANTHROPIC_API_KEY is ever set, set a monthly spend limit in the
   Anthropic console as well; that is the only hard money ceiling for it. */
const memory = new Map();
/* A one-way fingerprint of the caller, for counting only.

   The rate limiter never needs to know WHICH address it is looking at,
   only whether it has seen the same one before today. Hashing satisfies
   that completely while meaning the KV store no longer holds a browsable
   list of real IP addresses.

   The salt matters. IPv4 is only four billion values, so an unsalted hash
   of an address can be reversed by trying all of them in seconds. Set
   RATE_SALT as a secret on the Worker and the hashes become meaningless
   to anyone who does not have it. The fallback below keeps the code
   working if you have not, but it is public, so it is not a secret.

   Geolocation is untouched by any of this: it reads Cloudflare's own
   request.cf object and never looks at the address itself. */
async function ipFingerprint(ip, env) {
  const salt = (env && env.RATE_SALT) || "waypoint-rate-v1";
  const bytes = new TextEncoder().encode(salt + "|" + ip);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 10))
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

async function meter(request, env, ctx) {
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const who = await ipFingerprint(ip, env);
  const day = new Date().toISOString().slice(0, 10);
  // Layer 1: burst.
  if (env.BURST) {
    try {
      const { success } = await env.BURST.limit({ key: who });
      if (!success) return { ok: false, retryAfter: 60, why: "too many requests — try again in a minute" };
    } catch (e) {
      console.warn("[meter] burst limiter unavailable, carrying on:", e && e.message);
    }
  }

  // Layers 2 and 3.
  const keys = [
    { key: `ip:${who}:${day}`, cap: LIMITS.perIpPerDay, shared: true },
    { key: `all:${day}`, cap: LIMITS.globalPerDay, shared: false }
  ];

  for (const item of keys) {
    const key = item.key;
    const cap = item.cap;
    let n;

    if (env.RATE && item.shared) {
      try {
        n = +(await env.RATE.get(key) || 0) + 1;
      } catch (e) {
        n = (memory.get(key) || 0) + 1;
      }
      memory.set(key, n);
      if (memory.size > 5000) memory.clear();
      if (n <= cap) {
        ctx.waitUntil(
          env.RATE.put(key, String(n), { expirationTtl: 172800 })
            .catch(e => console.warn("[meter] KV write refused (daily write quota?):", e && e.message))
        );
      }
    } else {
      n = (memory.get(key) || 0) + 1;
      memory.set(key, n);
      if (memory.size > 5000) memory.clear();
    }

    if (n > cap) {
      const secs = Math.ceil(
        (Date.parse(day + "T23:59:59Z") - Date.now()) / 1000
      );

      return {
        ok: false,
        retryAfter: Math.max(60, secs),
        why: key.startsWith("all:")
          ? "daily limit for this site reached"
          : "daily limit reached for you"
      };
    }
  }
  return { ok: true };
}

/* One place that knows how to talk to whichever model is bound. */
async function runModel(env, prompt, maxTokens) {
  if (env.ANTHROPIC_API_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens || 400,
        messages: [{ role: "user", content: prompt }] })
    });
    if (!r.ok) throw new Error("anthropic " + r.status + " " + (await r.text()).slice(0, 120));
    const j = await r.json();
    return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  }
  if (env.AI) {
    // Cloudflare retires models on a schedule, and a hard-coded model ID
    // turns that into a silent outage months later. (@cf/meta/llama-3.1-8b-instruct
    // was retired on 2026-05-30 and took the briefings down with it.)
    // So: a candidate list, tried in order, with the first one that works
    // remembered for the life of the isolate. Set AI_MODEL to override.
    const candidates = [env.AI_MODEL, workingModel, ...AI_MODELS].filter(Boolean);
    let lastErr = null;
    for (const model of dedupe(candidates)) {
      try {
        const r = await env.AI.run(model,
          { messages: [{ role: "user", content: prompt }], max_tokens: maxTokens || 400 });
        const text = asText(r);
        if (text) { workingModel = model; return text; }
      } catch (e) {
        lastErr = String(e && e.message || e);
        // A deprecated/unavailable model is worth stepping past; anything
        // else (quota, capacity) will fail on the next one too, but the
        // loop is short enough that trying is cheaper than guessing.
        if (workingModel === model) workingModel = null;
      }
    }
    throw new Error(lastErr || "no Workers AI model in the candidate list responded");
  }
  throw new Error("no model bound");
}
/* Ordered cheapest-and-most-likely-available first. Update this list, not
   the call site, when Cloudflare refreshes the catalogue. */
const AI_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fast",   // -fast variants survived the May 2026 cull
  "@cf/zai-org/glm-4.7-flash",             // Cloudflare's own recommended replacement
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
];
let workingModel = null;
const dedupe = a => [...new Set(a)];
/* Newer Workers AI models do not all return a plain string in `response` —
   some return an object or a content array, which is what turned the
   briefing into "text.match is not a function". Everything downstream
   wants text, so normalise here rather than at three call sites. */
function asText(r) {
  if (r == null) return "";
  if (typeof r === "string") return r;
  const v = r.response !== undefined ? r.response : (r.result !== undefined ? r.result : r);
  if (typeof v === "string") return v;
  /* Joined with a newline, NOT an empty string.

     This mattered more than it looks. The model returns its four notes as
     an array of four strings, exactly as asked. Gluing them with "" made
     "...before heading out." and "Be prepared for steep stairs..." into one
     466-character run-on sentence with no separator anywhere in it, and
     nothing downstream could tell where one note ended and the next began.
     The briefings were dead for weeks because of this one character. */
  if (Array.isArray(v)) return v.map(x => typeof x === "string" ? x : (x && (x.text || x.content) || "")).filter(Boolean).join("\n");
  if (v && typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.content === "string") return v.content;
    if (Array.isArray(v.content)) return v.content.map(c => (c && c.text) || "").filter(Boolean).join("\n");
    try { return JSON.stringify(v); } catch (e) { return ""; }
  }
  return String(v == null ? "" : v);
}

/* ---------- 1 · WHERE ---------------------------------------------------
   Cloudflare attaches this to every request. No IP-lookup round trip, no
   permission prompt, and more accurate than the free IP services.      */
function where(request) {
  const cf = request.cf || {};
  return json({
    city: cf.city || null,
    region: cf.region || null,
    /* ISO 3166-2 subdivision code — "KA" for Karnataka, "BY" for Bayern.
       Public holidays are declared at this level in India, Germany, Spain,
       Switzerland, the US, Canada, Australia and Malaysia among others, so
       this is what decides which holidays a traveller actually gets off.
       Cloudflare has always sent it; we were discarding it and guessing
       from coordinates instead. */
    regionCode: cf.regionCode || null,
    country: cf.country ? (REGION_NAMES(cf.country) || cf.country) : null,
    cc: cf.country || null,
    lat: cf.latitude ? +cf.latitude : null,
    lon: cf.longitude ? +cf.longitude : null,
    tz: cf.timezone || null,
    postal: cf.postalCode || null
  }, 200, { "Cache-Control": "no-store" });
}
function REGION_NAMES(cc) {
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(cc); } catch { return cc; }
}

/* ---------- 2 · BRIEF ---------------------------------------------------
   Local intelligence for the chosen destination. Deliberately narrow: it
   returns short, checkable notes. It never returns a score, a ranking or
   a recommendation, because model output must not touch the decision.  */
async function brief(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const place = String(b.place || "").slice(0, 80);
  if (!place) return json({ error: "place required" }, 400);
  const month = String(b.month || "").slice(0, 20);
  const key = `brief:${place}:${b.country}:${month}:${b.party}:${(b.interests || []).join(",")}`;

  const cache = caches.default;
  const cacheKey = new Request("https://waypoint.cache/" + encodeURIComponent(key));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const prompt =
`You are briefing a traveller who has ALREADY decided to go to ${place}, ${b.country} in ${month} for ${b.days} days.
They are travelling as: ${b.party}. They care about: ${(b.interests || []).join(", ") || "general sightseeing"}.

Give exactly 4 short notes (max 24 words each) that a well-travelled friend would mention and a guidebook usually buries:
1. one thing specific to ${month} there (a festival, a season, a closure, a crowd or price pattern)
2. one practical logistics detail that trips people up
3. one thing genuinely worth doing that is not the single most obvious attraction
4. one honest caveat or downside

Rules: no preamble, no numbering, no markdown. Do not recommend other destinations. Do not invent named events you are unsure about — prefer general seasonal patterns to specific dates. Reply ONLY with a JSON array of 4 strings.`;

  const model = env.ANTHROPIC_API_KEY ? "claude" : env.AI ? "workers-ai" : "none";
  let notes = null, failure = null, raw = "";
  try {
    raw = await runModel(env, prompt, 420);
    notes = extractArray(raw);
  }
  catch (e) { failure = String(e && e.message || e); }

  /* When this fails, say WHY in a way that can be read from the Network
     tab. "nothing usable" on its own cannot distinguish a model that never
     answered from one that answered in a shape the parser rejected, and
     those need opposite fixes. So: which model actually replied, how much
     text came back, and the first 300 characters of it. */
  if (!notes) return json({
    notes: [], model,
    modelId: workingModel || env.AI_MODEL || null,
    rawLength: asText(raw).length,
    rawSample: asText(raw).slice(0, 300),
    error: failure || "the model returned nothing usable"
  });

  const res = json({ notes: notes.slice(0, 4), model, place },
    200, { "Cache-Control": "public, max-age=86400" });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
/* Pull four sentences out of whatever the model actually said.

   The prompt asks for a JSON array and nothing else. Large models comply.
   The small ones available on Workers AI frequently do not: they wrap the
   array in a markdown fence, or add "Here are four notes:" in front of it,
   or ignore JSON altogether and return a numbered list. All of those are
   perfectly good answers that the old parser threw away, which is why the
   briefings looked dead while the model was in fact replying every time.

   So: try strict JSON, then repair the usual breakages, then give up on
   JSON entirely and read it as a list. Only if all three find nothing do
   we report a failure.                                                   */
function extractArray(text) {
  text = asText(text);
  if (!text) return null;

  const clean = a => {
    if (!Array.isArray(a)) return null;
    const out = a.map(x => typeof x === "string" ? x.trim() : "")
                 .filter(x => x.length > 5);
    return out.length ? out : null;
  };

  // Strip a markdown fence if the model added one.
  let body = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");

  // 1 · the array exactly as asked for
  const m = body.match(/\[[\s\S]*\]/);
  if (m) {
    try { const got = clean(JSON.parse(m[0])); if (got) return got; } catch {}

    /* 2 · the same array with the mistakes models make: a trailing comma
       before the bracket, curly quotes from a helpful tokeniser, or single
       quotes because it was thinking in Python. */
    const repaired = m[0]
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/,\s*([\]}])/g, "$1")
      .replace(/'([^'\n]{6,})'/g, (_, t) => JSON.stringify(t));
    try { const got = clean(JSON.parse(repaired)); if (got) return got; } catch {}
  }

  /* 3 · no usable JSON. Read it as a list instead: one note per line,
     with numbering, bullets, quotes and stray brackets taken off. This is
     the branch that rescues a small model's numbered-list answer. */
  const lines = body
    .split(/\r?\n+/)
    .map(l => l.trim()
      .replace(/^[-*\u2022]\s*/, "")        // bullets
      .replace(/^\d+[.)]\s*/, "")           // 1. or 1)
      .replace(/^["'\[\s]+|["',\]\s]+$/g, "")  // quotes, brackets, commas
      .trim())
    .filter(l => l.length > 15 && l.length < 600)
    // Drop the model's own preamble rather than presenting it as a note.
    .filter(l => !/^(here are|sure[,!]|certainly|of course|notes?:)/i.test(l));

  if (lines.length >= 2) return lines;

  /* 4 · one long blob and no line breaks anywhere.

     This is what a run-on join looks like from the parser's side, and it
     is worth rescuing rather than discarding: the sentences are perfectly
     good, they have simply lost their separator. A full stop followed
     immediately by a capital letter with no space is not something normal
     prose does, so it is a reliable seam. Ordinary sentence ends are used
     as a fallback seam after that.                                       */
  const blob = lines[0] || body.trim();
  if (blob.length > 80) {
    let parts = blob.split(/(?<=[.!?])(?=[A-Z])/);            // no space: a join artefact
    if (parts.length < 2) parts = blob.split(/(?<=[.!?])\s+(?=[A-Z])/);  // normal prose
    parts = parts.map(x => x.trim()).filter(x => x.length > 15 && x.length < 600);
    if (parts.length >= 2) return parts;
  }

  return null;
}

/* ---------- 3 · PARSE ---------------------------------------------------
   "somewhere warm and cheap in March, good food, no long flights"
   → structured parameters the engine already understands.               */
async function parse(request, env) {
  const b = await request.json().catch(() => ({}));
  const text = String(b.text || "").slice(0, 400);
  if (!text) return json({ error: "text required" }, 400);

  const prompt =
`Convert this travel wish into JSON. Reply with ONLY the JSON object, no prose.
Wish: "${text}"

Schema:
{"month": 0-11 or null, "days": integer or null,
 "party": "solo"|"couple"|"family"|"friends"|"multigen" or null,
 "interests": array from ["beach","mountains","wildlife","heritage","art","food","markets","nightlife","adventure","snow","water","pilgrim","wellness","quiet","kids","scenery","romantic","desert"],
 "price": 0-100 (how much budget matters, higher = matters more) or null,
 "comfort": 0-100 or null, "pace": 0-100 or null, "adventure": 0-100 or null,
 "maxHours": number or null}
Month is zero-indexed (January = 0). Only include what the wish actually says; use null otherwise.`;

  let out = null;
  try { out = extractObject(await runModel(env, prompt, 320)); } catch (e) {}
  return json(out || { error: "could not parse" }, out ? 200 : 422);
}
function extractObject(text) {
  text = asText(text);
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/* ---------- 4 · NEARBY --------------------------------------------------
   The same Wikidata query the browser used to fire directly. Behind the
   Worker it gets a proper User-Agent, edge caching and one shared rate
   budget instead of one per visitor — which is the difference between
   "works in a demo" and "does not get blocked at 500 users".            */
async function nearby(request, ctx, env) {
  const u = new URL(request.url);
  const lat = +u.searchParams.get("lat"), lon = +u.searchParams.get("lon");
  const r = Math.min(1200, Math.max(50, +u.searchParams.get("r") || 400));
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: "lat/lon required" }, 400);

  const cache = caches.default;
  const ck = new Request(`https://waypoint.cache/nearby/${lat.toFixed(1)}/${lon.toFixed(1)}/${Math.round(r / 50) * 50}`);
  const hit = await cache.match(ck);
  if (hit) return hit;

  const q = `SELECT ?item ?itemLabel ?countryLabel ?cc ?lat ?lon WHERE{
    SERVICE wikibase:around{ ?item wdt:P625 ?loc. bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral.
      bd:serviceParam wikibase:radius "${r}". }
    { VALUES ?cls {wd:Q515 wd:Q46169 wd:Q23397 wd:Q40357 wd:Q1187811} ?item wdt:P31 ?cls. }
    ?item wikibase:sitelinks ?links. FILTER(?links>=8)
    ?item wdt:P17 ?country. OPTIONAL{?country wdt:P297 ?cc.}
    BIND(geof:latitude(?loc) AS ?lat) BIND(geof:longitude(?loc) AS ?lon)
    SERVICE wikibase:label{ bd:serviceParam wikibase:language "en". } } ORDER BY DESC(?links) LIMIT 12`;

  const wd = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": `Waypoint/2.0 (travel decision engine; ${(env && env.CONTACT_EMAIL) || "admin@waypoint.holiday"})`
    }
  });
  if (!wd.ok) return json({ items: [] }, 200);
  const data = await wd.json();
  const res = json(data, 200, { "Cache-Control": "public, max-age=604800" });
  ctx.waitUntil(cache.put(ck, res.clone()));
  return res;
}

/* ---------- 6 · FX ------------------------------------------------------
   Was: every visitor fetched open.er-api.com independently.
   Now: Frankfurter, which serves the European Central Bank's own daily
   reference rates, needs no key and has no quota beyond abuse limiting —
   fetched once and cached at the edge for a day. The ECB publishes once
   each working day, so anything more often was pure waste.

   The response carries the ECB's own publication date, so the engine can
   age the rate rather than assuming it is current.                      */
async function fx(ctx) {
  const cache = caches.default;
  const ck = new Request("https://waypoint.cache/fx/usd/v4");
  const hit = await cache.match(ck);
  if (hit) return hit;

  /* THE TWO SOURCES ARE NOW MERGED RATHER THAN RANKED, AND THAT IS A FIX,
     not a tidy-up.

     Frankfurter serves the ECB's own reference rates, which is the most
     authoritative free source there is — but the ECB publishes rates for
     roughly thirty currencies, all of them major. It has no Sri Lankan
     rupee, no dong, no dirham, no Egyptian pound, no shilling, no
     tenge. Because it was tried first and almost never fails, the wider
     fallback below effectively never ran, and the front end quietly had
     no rate at all for most of the atlas. The Money section reads the
     rate to decide whether it can say anything, so for a traveller
     looking at Sri Lanka the entire block collapsed to a bare cost
     figure — no exchange rate, no card, no comparison.

     So: ExchangeRate-API supplies breadth (160-odd currencies) and the
     ECB is layered on top of it, winning wherever it has an opinion.
     Every traveller gets a rate; the thirty that matter most are still
     the ECB's own numbers. */
  let wide = null, ecb = null, ecbDate = null;

  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    if (r.ok) {
      const j = await r.json();
      if (j && j.rates && Object.keys(j.rates).length > 50) wide = j.rates;
    }
  } catch (e) {}

  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD");
    if (r.ok) {
      const j = await r.json();
      if (j && j.rates) { ecb = j.rates; ecbDate = j.date || null; }
    }
  } catch (e) {}

  if (!wide && !ecb) return json({ error: "no rate source reachable" }, 502);

  const rates = { ...(wide || {}), ...(ecb || {}), USD: 1 };
  const source = (ecb && wide) ? "European Central Bank, widened by ExchangeRate-API"
               : ecb           ? "European Central Bank via Frankfurter"
                               : "ExchangeRate-API";

  const out = { base: "USD", rates, date: ecbDate, source,
                ecbCount: ecb ? Object.keys(ecb).length : 0,
                count: Object.keys(rates).length,
                observed_at: new Date().toISOString(),
                confidence: ecb ? 0.98 : 0.9 };

  const res = json(out, 200, { "Cache-Control": "public, max-age=86400" });
  ctx.waitUntil(cache.put(ck, res.clone()));
  return res;
}

/* ---------- 6b · PRICE LEVELS ------------------------------------------
   The World Bank's price level index (PPP divided by the market exchange
   rate, US = 1.00) for every economy it covers, plus the US consumer
   price index used to age the dollar anchors in waypoint-prices.js.

   WHY THESE TWO AND NOTHING ELSE. The price level already contains that
   country's inflation and its currency movement, so it is the one number
   that keeps the whole cost model current without anybody editing a
   price. The US CPI handles the other half — the anchors are quoted in
   dollars, so they have to move when dollars do.

   There is no inflation constant anywhere in this. "Everything rises 5%
   a year" is a fake precision: in 2026 US lodging ran +3.0% while airline
   fares ran +25.5%.

   Free, keyless, no quota beyond abuse limiting. The World Bank publishes
   annually, so this is cached at the edge for 30 days — anything more
   often is pure waste, exactly as with the ECB rates above.            */
async function prices(ctx) {
  const cache = caches.default;
  const ck = new Request("https://waypoint.cache/prices/v2");
  const hit = await cache.match(ck);
  if (hit) return hit;

  const WB = "https://api.worldbank.org/v2";
  const opts = { headers: { accept: "application/json",
                            "User-Agent": "Waypoint/3.1 (travel decision engine)" } };

  let priceLevel = null, year = null, usCPI = null, indicator = null;

  /* The World Bank retires indicator codes without warning, and a dead code
     does not fail loudly — it returns a JSON object containing the words
     "The indicator was not found", which parses perfectly and contains no
     data. PA.NUS.PPPC.RF died exactly that way and took live pricing with
     it for months, invisibly, because the fallback table is good enough
     that nobody noticed.

     So: a list, tried in order, and a note of which one answered.

       PA.NUS.GDP.PLI   the current price level index (GDP)
       PA.NUS.PPPC.RF   the retired code, kept in case it is restored
       PA.NUS.PPP       raw PPP conversion factor — needs dividing by the
                        exchange rate below, but between them they rebuild
                        the same number from parts that are unlikely to be
                        retired together                                  */
  const CANDIDATES = ["PA.NUS.GDP.PLI", "PA.NUS.PPPC.RF"];

  const fetchSeries = async (code) => {
    try {
      const r = await fetch(`${WB}/country/all/indicator/${code}` +
        `?format=json&mrnev=1&per_page=400`, opts);
      if (!r.ok) return null;
      const j = await r.json();
      // A retired code answers [{message:[...]}] — an array whose second
      // element is missing entirely. Real data always has j[1].
      const rows = Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [];
      if (!rows.length) return null;
      const out = {};
      let latest = null;
      for (const row of rows) {
        const cc = row && row.country && row.country.id;
        const v = +row.value;
        // Aggregates ("World", "Euro area") come back with codes the atlas
        // never uses. The plausibility test happens after normalising,
        // because we do not yet know what scale this series is on.
        if (!cc || cc.length !== 2 || !isFinite(v) || v <= 0) continue;
        out[cc] = v;
        if (!latest || +row.date > +latest) latest = row.date;
      }
      return Object.keys(out).length > 50 ? { out, year: latest } : null;
    } catch (e) { return null; }
  };

  for (const code of CANDIDATES) {
    const got = await fetchSeries(code);
    if (got) { priceLevel = got.out; year = got.year; indicator = code; break; }
  }

  /* Last resort: rebuild the ratio from its two ingredients. */
  if (!priceLevel) {
    const [ppp, fx] = await Promise.all([
      fetchSeries("PA.NUS.PPP"), fetchSeries("PA.NUS.FCRF")
    ]);
    if (ppp && fx) {
      const out = {};
      for (const cc in ppp.out) {
        const rate = fx.out[cc];
        if (isFinite(rate) && rate > 0) out[cc] = ppp.out[cc] / rate;
      }
      if (Object.keys(out).length > 50) {
        priceLevel = out; year = ppp.year;
        indicator = "PA.NUS.PPP / PA.NUS.FCRF";
      }
    }
  }

  /* Normalise so the United States is exactly 1.00.

     This is what makes the code survive the next rename. The retired
     series was published on a US = 1.00 scale; the replacement is an
     index, which is conventionally US = 100. Dividing every country by
     whatever the US reports makes the scale irrelevant — the answer is
     right whether the source says 1, 100, or something else entirely.  */
  if (priceLevel) {
    const us = priceLevel.US;
    if (isFinite(us) && us > 0) {
      const scaled = {};
      for (const cc in priceLevel) {
        const v = priceLevel[cc] / us;
        // Now that everything is on a known scale, implausible values mean
        // a data error rather than a very expensive country.
        if (v > 0.05 && v < 3) scaled[cc] = Math.round(v * 1000) / 1000;
      }
      priceLevel = Object.keys(scaled).length > 50 ? scaled : null;
    } else {
      priceLevel = null;   // no US row, no scale, no trustworthy answer
    }
  }

  try {
    const r = await fetch(`${WB}/country/USA/indicator/FP.CPI.TOTL?format=json&mrnev=1`, opts);
    if (r.ok) {
      const j = await r.json();
      const v = j && j[1] && j[1][0] && +j[1][0].value;
      if (isFinite(v) && v > 50 && v < 1000) usCPI = Math.round(v * 100) / 100;
    }
  } catch (e) {}

  /* Deliberately 200, not 502.

     The browser handles this perfectly: it keeps the price table shipped
     with the app and carries on. Returning an error status for a condition
     that is fully handled painted a red line in every visitor's console on
     every visit, which trains whoever is looking at that console to ignore
     it — and the next error, the real one, goes unread with it.          */
  if (!priceLevel)
    return json({ priceLevel: null, fallback: true,
      error: "no World Bank price series returned usable data",
      tried: CANDIDATES.concat("PA.NUS.PPP / PA.NUS.FCRF"),
      observed_at: new Date().toISOString() },
      200, { "Cache-Control": "no-store" });

  const out = {
    priceLevel, usCPI, year,
    base: "US = 1.00",
    indicator,
    source: "World Bank / ICP price level index",
    method: "PPP conversion factor divided by market exchange rate",
    observed_at: new Date().toISOString(),
    confidence: 0.9,
    note: "Annual. Carries each economy's own inflation and currency movement."
  };
  const res = json(out, 200, { "Cache-Control": "public, max-age=2592000" });
  ctx.waitUntil(cache.put(ck, res.clone()));
  return res;
}

/* ---------- 7 · CLIMATOLOGY ---------------------------------------------
   Was: the browser fetched five fixed years (2020–2024) of ERA5 per
   destination, on every visit, and reduced them to two numbers.

   Three problems with that, all fixed here:
     · the window was hard-coded, so it aged silently and by now excludes
       everything recent;
     · five years is a small sample for a "normal";
     · a mean hides the thing travellers actually care about, which is
       spread. "23°C average" covers both a reliable 23 and a coin flip
       between 15 and 31.

   So: a rolling 15-year window ending last complete year, reduced to
   percentiles rather than means, computed once and cached for 30 days.  */
async function climate(request, ctx) {
  const u = new URL(request.url);
  const lat = +u.searchParams.get("lat"), lon = +u.searchParams.get("lon");
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: "lat/lon required" }, 400);

  const endYear = new Date().getUTCFullYear() - 1;
  const startYear = endYear - 14;
  const cache = caches.default;
  const ck = new Request(`https://waypoint.cache/clim/v3/${lat.toFixed(2)}/${lon.toFixed(2)}/${endYear}`);
  const hit = await cache.match(ck);
  if (hit) return hit;

  /* Open-Meteo bills a request by days × variables, not by call, so a
     15-year four-variable pull is an expensive single request and gets
     refused under load — which is what produced the 502s. Ask for a
     narrower window first and widen only if it is cheap to do so, then
     fall back to progressively shorter windows rather than failing. */
  const attempt = async (fromYear, vars) => {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=${fromYear}-01-01&end_date=${endYear}-12-31` +
      `&daily=${vars.join(",")}&timezone=auto`;
    const r = await fetch(url);
    if (!r.ok) return { err: `upstream ${r.status}: ${(await r.text()).slice(0, 160)}` };
    const j = await r.json();
    if (!j || !j.daily || !j.daily.time) return { err: "upstream returned no daily series" };
    return { j, fromYear };
  };

  const FULL = ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_hours"];
  const LEAN = ["temperature_2m_max", "precipitation_sum"];
  let got = null, lastErr = null;
  const errs = [];
  for (const [fy, vars] of [[startYear, FULL], [endYear - 9, FULL], [endYear - 9, LEAN], [endYear - 4, LEAN]]) {
    try {
      const a = await attempt(fy, vars);
      if (a.j) { got = a; break; }
      lastErr = a.err;
    } catch (e) { lastErr = String(e && e.message || e); }
    errs.push(`${fy}/${vars.length}v: ${lastErr}`);
  }
  /* Written to Workers Logs (Workers & Pages → waypoint → Observability),
     so failures can be studied after the fact instead of being caught live
     in a browser. Search the logs for "climate_upstream". */
  if (!got) {
    console.warn(JSON.stringify({ event: "climate_upstream_failed", lat, lon, attempts: errs }));
  } else if (errs.length) {
    console.warn(JSON.stringify({ event: "climate_upstream_retried", lat, lon, usedFrom: got.fromYear, attempts: errs }));
  }
  // Diagnosable rather than a bare 502 — the browser falls back to its own
  // direct fetch either way, but now the reason is visible in the response.
  if (!got) return json({ error: lastErr || "climate upstream unavailable", lat, lon }, 502);
  const j = got.j;
  const usedFrom = got.fromYear;

  const D = j.daily.time, TX = j.daily.temperature_2m_max || [],
        PR = j.daily.precipitation_sum || [];
  // The lean fallback omits some series entirely, so every optional array
  // is defaulted rather than indexed blind.
  const TN = j.daily.temperature_2m_min || [], PH = j.daily.precipitation_hours || [];
  const acc = Array.from({ length: 12 }, () => ({ tx: [], tn: [], wetByYear: {}, ph: [], years: new Set() }));
  for (let i = 0; i < D.length; i++) {
    const m = +D[i].slice(5, 7) - 1, y = D[i].slice(0, 4), A = acc[m];
    A.years.add(y);
    if (TX[i] != null) A.tx.push(TX[i]);
    if (TN[i] != null) A.tn.push(TN[i]);
    if (PH[i] != null) A.ph.push(PH[i]);
    // "wet day" = 1mm+, counted per year so we can report the spread
    // between a dry year and a wet one instead of just their average.
    if (PR[i] != null) { A.wetByYear[y] = (A.wetByYear[y] || 0) + (PR[i] >= 1 ? 1 : 0); }
  }
  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10;
  };
  const months = acc.map(A => {
    if (!A.tx.length) return null;
    const wet = Object.values(A.wetByYear);
    return {
      tmax_p10: pct(A.tx, 0.10), tmax_p50: pct(A.tx, 0.50), tmax_p90: pct(A.tx, 0.90),
      tmin_p10: pct(A.tn, 0.10), tmin_p50: pct(A.tn, 0.50),
      wet_p10: pct(wet, 0.10), wet_p50: pct(wet, 0.50), wet_p90: pct(wet, 0.90),
      precip_hours_p50: pct(A.ph, 0.50),
      // what the engine consumes directly, kept under the old names so
      // nothing downstream had to change
      tmax: pct(A.tx, 0.50), wetDays: Math.round(pct(wet, 0.50) || 0),
      years: A.years.size
    };
  });

  const res = json({
    months,
    source: "Copernicus ERA5 via Open-Meteo archive",
    window: `${usedFrom}-${endYear}`,
    years: endYear - usedFrom + 1,
    method: "percentiles of daily values, rolling 15-year window",
    observed_at: new Date().toISOString(),
    confidence: 0.93
  }, 200, { "Cache-Control": "public, max-age=2592000" });
  ctx.waitUntil(cache.put(ck, res.clone()));
  return res;
}

/* ---------- 8 · LIVE CONDITIONS -----------------------------------------
   One request, one cached snapshot, for the whole shortlist:

     · near-term forecast — the variables that actually change a trip, not
       just temperature: apparent temperature, precipitation probability
       AND hours, wind, gusts, UV, visibility, snowfall
     · air quality from CAMS — a destination can be perfect on every other
       axis and still be a bad week under smoke
     · active disasters from GDACS, earthquakes from USGS, and wildfires
       from NASA FIRMS if a key is set

   The hazard feeds are global and fetched once for everybody, then
   filtered by distance in the engine. This is the difference between
   "it is cyclone season" and "there is a cyclone, 300 km away, now".

   Every observation returned carries observed_at. Nothing downstream is
   allowed to treat a fresh reading and a stale one as the same thing.  */
async function live(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const places = (Array.isArray(b.places) ? b.places : []).slice(0, 8)
    .filter(p => isFinite(+p.la) && isFinite(+p.lo));
  if (!places.length) return json({ error: "places required" }, 400);
  const leadDays = Math.max(0, Math.min(16, +b.leadDays || 0));
  const wantForecast = leadDays <= 16;

  const nowISO = new Date().toISOString();
  const lats = places.map(p => (+p.la).toFixed(3)).join(",");
  const lons = places.map(p => (+p.lo).toFixed(3)).join(",");

  const [weather, air, events] = await Promise.all([
    wantForecast ? omForecast(lats, lons) : Promise.resolve(null),
    omAir(lats, lons),
    hazardEvents(env, ctx)
  ]);

  const byPlace = {};
  places.forEach((p, i) => {
    const key = p.n + "|" + (+p.la).toFixed(2) + "," + (+p.lo).toFixed(2);
    byPlace[key] = {
      forecast: weather ? pickForecast(weather[i], leadDays) : null,
      forecastSource: "Open-Meteo (national weather models)",
      air: air ? pickAir(air[i]) : null,
      observed_at: nowISO,
      ageH: 0
    };
    byPlace[p.n] = byPlace[key];   // name-only lookup, for convenience
  });

  return json({
    byPlace, events,
    observed_at: nowISO, ageH: 0,
    sources: [
      "Open-Meteo forecast", "Open-Meteo / CAMS air quality",
      "GDACS", "USGS earthquakes"
    ].concat(env.FIRMS_MAP_KEY ? ["NASA FIRMS"] : []),
    confidence: 0.9
  }, 200, { "Cache-Control": "public, max-age=1800" });
}

/* Open-Meteo takes comma-separated coordinates, so the whole shortlist is
   one call rather than one call per destination. */
async function omForecast(lats, lons) {
  const daily = ["temperature_2m_max", "apparent_temperature_max", "precipitation_sum",
    "precipitation_hours", "precipitation_probability_max", "wind_speed_10m_max",
    "wind_gusts_10m_max", "uv_index_max", "snowfall_sum"].join(",");
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
      `&daily=${daily}&hourly=visibility,relative_humidity_2m&forecast_days=16&timezone=auto`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : [j];
  } catch (e) { return null; }
}
async function omAir(lats, lons) {
  try {
    const r = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lats}` +
      `&longitude=${lons}&hourly=pm2_5,pm10,ozone,aerosol_optical_depth&forecast_days=2&timezone=auto`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : [j];
  } catch (e) { return null; }
}

/* Reduce 16 days of forecast to the window the traveller is actually in.
   A trip 12 days out cares about days 12–16, not tomorrow. */
function pickForecast(w, leadDays) {
  if (!w || !w.daily || !w.daily.time) return null;
  const d = w.daily, n = d.time.length;
  const from = Math.max(0, Math.min(n - 1, Math.round(leadDays)));
  const to = Math.min(n, from + 7);
  const slice = (arr) => (arr || []).slice(from, to).filter(v => v != null);
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const max = a => a.length ? Math.max(...a) : null;
  const tmax = avg(slice(d.temperature_2m_max));
  const rh = w.hourly && w.hourly.relative_humidity_2m
    ? avg(w.hourly.relative_humidity_2m.slice(from * 24, to * 24).filter(v => v != null)) : null;
  const vis = w.hourly && w.hourly.visibility
    ? avg(w.hourly.visibility.slice(from * 24, to * 24).filter(v => v != null)) : null;
  const precipHours = avg(slice(d.precipitation_hours));
  const days = to - from;
  const wetDays = slice(d.precipitation_sum).filter(v => v >= 1).length;
  return {
    days, tmax: r1(tmax),
    apparent: r1(avg(slice(d.apparent_temperature_max))),
    humidity: r1(rh),
    precipProb: r1(avg(slice(d.precipitation_probability_max))),
    precipHours: r1(precipHours),
    precipSum: r1(avg(slice(d.precipitation_sum))),
    // scaled to a month so it is directly comparable with the climatology
    wetDaysEquiv: days ? Math.round(wetDays / days * 30) : null,
    wind: r1(avg(slice(d.wind_speed_10m_max))),
    windGust: r1(max(slice(d.wind_gusts_10m_max))),
    uv: r1(max(slice(d.uv_index_max))),
    snowfall: r1(avg(slice(d.snowfall_sum))),
    visibility: vis == null ? null : Math.round(vis)
  };
}
function pickAir(a) {
  if (!a || !a.hourly || !a.hourly.pm2_5) return null;
  const take = arr => {
    const v = (arr || []).slice(0, 24).filter(x => x != null);
    return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 10) / 10 : null;
  };
  return { pm2_5: take(a.hourly.pm2_5), pm10: take(a.hourly.pm10),
           ozone: take(a.hourly.ozone), aod: take(a.hourly.aerosol_optical_depth), ageH: 0 };
}
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

/* ── ACTIVE HAZARD EVENTS ────────────────────────────────────────────
   Global feeds, fetched once for every visitor and cached for an hour.
   Returned as a flat list of located events; the engine decides what
   each one means for each destination by distance and age.           */
async function hazardEvents(env, ctx) {
  const cache = caches.default;
  const ck = new Request("https://waypoint.cache/hazards/v3");
  const hit = await cache.match(ck);
  if (hit) { try { return (await hit.json()).events || []; } catch (e) {} }

  const out = [];
  const ageH = iso => { const t = Date.parse(iso); return isFinite(t) ? Math.max(0, (Date.now() - t) / 36e5) : 0; };

  /* GDACS — cyclones, floods, quakes, droughts, volcanoes, wildfires. */
  try {
    const r = await fetch("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?fromdate=&todate=&alertlevel=Orange;Red", {
      headers: { "User-Agent": "Waypoint/3.0 (travel decision engine)" }
    });
    if (r.ok) {
      const j = await r.json();
      (j.features || []).slice(0, 120).forEach(f => {
        const p = f.properties || {}, g = f.geometry || {};
        const c = Array.isArray(g.coordinates) ? g.coordinates : null;
        if (!c) return;
        out.push({
          source: "GDACS", type: p.eventtype || "OT",
          title: p.htmldescription ? String(p.name || p.eventname || p.eventtype)
                                   : String(p.name || p.eventname || "Hazard event"),
          alert: p.alertlevel || "Green",
          lat: +c[1], lon: +c[0],
          when: p.fromdate || p.datemodified || null,
          ageH: ageH(p.todate || p.datemodified || p.fromdate),
          url: p.url && p.url.report ? p.url.report : null
        });
      });
    }
  } catch (e) {}

  /* USGS — significant quakes only, and treated as information rather
     than as a blanket penalty on a whole country. */
  try {
    const r = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson");
    if (r.ok) {
      const j = await r.json();
      (j.features || []).forEach(f => {
        const p = f.properties || {}, c = (f.geometry || {}).coordinates;
        if (!c || (p.mag || 0) < 5.5) return;
        out.push({
          source: "USGS", type: "EQ",
          title: `M${(p.mag || 0).toFixed(1)} earthquake`,
          alert: p.mag >= 7 ? "Red" : p.mag >= 6.3 ? "Orange" : "Green",
          lat: +c[1], lon: +c[0],
          radiusKm: p.mag >= 7 ? 320 : 180,
          when: p.time ? new Date(p.time).toISOString() : null,
          ageH: p.time ? Math.max(0, (Date.now() - p.time) / 36e5) : 0,
          url: p.url || null
        });
      });
    }
  } catch (e) {}

  /* NASA FIRMS — optional, needs a free MAP_KEY. Without it Waypoint
     falls back to the seasonal fire model, which is honest about being
     a season rather than an observation. */
  if (env.FIRMS_MAP_KEY) {
    try {
      const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/world/1`);
      if (r.ok) {
        const rows = (await r.text()).trim().split("\n");
        const head = rows.shift().split(",");
        const iLat = head.indexOf("latitude"), iLon = head.indexOf("longitude"),
              iConf = head.indexOf("confidence"), iFrp = head.indexOf("frp");
        const strong = [];
        for (const line of rows) {
          const c = line.split(",");
          const frp = +c[iFrp] || 0;
          if (frp < 60) continue;                       // only real fires, not every hot pixel
          if ((c[iConf] || "").toLowerCase() === "l") continue;
          strong.push({ lat: +c[iLat], lon: +c[iLon], frp });
        }
        // cluster crudely so one fire complex is one event, not 400 pixels
        const seen = [];
        for (const f of strong) {
          if (seen.some(s => Math.abs(s.lat - f.lat) < 0.6 && Math.abs(s.lon - f.lon) < 0.6)) continue;
          seen.push(f);
          if (seen.length > 60) break;
        }
        seen.forEach(f => out.push({
          source: "NASA FIRMS", type: "WF", title: "Active wildfire detected",
          alert: f.frp > 300 ? "Orange" : "Green",
          lat: f.lat, lon: f.lon, ageH: 12,
          when: new Date(Date.now() - 12 * 36e5).toISOString()
        }));
      }
    } catch (e) {}
  }

  const res = json({ events: out, observed_at: new Date().toISOString() },
    200, { "Cache-Control": "public, max-age=3600" });
  ctx.waitUntil(cache.put(ck, res.clone()));
  return out;
}

/* ---------- 5 · GEOCODE -------------------------------------------------
   Nominatim's usage policy requires a descriptive User-Agent and caps at
   one request per second. A browser cannot honour either; a Worker can. */
/* ---------- 10 · REPUTATION -------------------------------------------
   "Is this place actually well regarded by travellers?"

   THE DESIGN CONSTRAINT. Waypoint must keep working, for free, forever.
   That rules out building on Tripadvisor or Google Places, which have the
   best data and are both fundamentally paid APIs with free allowances.
   So this endpoint is an aggregator with a free floor: it always returns
   something from sources that cost nothing, and it returns MORE if you
   have chosen to plug a commercial source in.

   WHAT IT WILL NOT DO. It will not scrape. It will not present a
   popularity number as a rating. It will not invent a review count. Where
   a signal is missing the field is absent, and the client's confidence
   maths takes care of the rest — silence is data too.

   TWO KINDS OF SIGNAL, KEPT APART ON PURPOSE:

     rating / reviews   what travellers said, and how many said it.
                        Only a review source can supply this.
     count              how many museums / restaurants / beaches exist.
                        OpenStreetMap supplies this. It is SUPPLY, not
                        quality, and the client is careful never to score
                        it as though it were quality.

   Cached for 14 days per destination. Reputation moves on a scale of
   months, and the cache is what keeps every upstream seeing one caller
   rather than one per visitor.                                          */
async function reputation(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const places = (Array.isArray(b.places) ? b.places : []).slice(0, 8)
    .filter(p => p && p.n && isFinite(+p.la) && isFinite(+p.lo));
  if (!places.length) return json({ error: "places required" }, 400);

  const wantSupply = b.supply !== false;
  const nowISO = new Date().toISOString();
  const byPlace = {};
  const sources = ["Wikipedia pageviews (Wikimedia REST)", "Wikivoyage (narrative, not rating)"];
  if (wantSupply) sources.push("OpenStreetMap via Overpass");
  if (env.GOOGLE_PLACES_KEY) sources.push("Google Places API");

  const settled = await Promise.allSettled(places.map(p =>
    onePlace(p, env, ctx, wantSupply)));
  settled.forEach((s, i) => {
    if (s.status !== "fulfilled" || !s.value) return;
    byPlace[places[i].n] = s.value;
  });

  return json({
    byPlace, sources, observed_at: nowISO,
    method: "free-source reputation aggregate; ratings shrunk client-side against the set mean",
    notes: {
      popularity: "attention, from Wikipedia pageviews. Not a quality signal and never mixed with one.",
      supply: "OpenStreetMap feature counts. Evidence that a category exists, not that it is good.",
      context: "Wikivoyage prose. Description and seasonality only — never scored, never treated as a rating.",
      commercial: env.GOOGLE_PLACES_KEY
        ? "a commercial review source is enabled on this Worker"
        : "no commercial review source configured — ratings will be absent"
    }
  }, 200, { "Cache-Control": "public, max-age=3600" });
}

/* One destination, all adapters, cached as a unit. */
async function onePlace(p, env, ctx, wantSupply) {
  const cache = caches.default;
  const key = `${(+p.la).toFixed(2)},${(+p.lo).toFixed(2)}`;
  const ck = new Request(`https://waypoint.cache/rep/v2/${encodeURIComponent(p.n)}/${key}` +
    `/${wantSupply ? "s" : "n"}${env.GOOGLE_PLACES_KEY ? "g" : ""}`);
  const hit = await cache.match(ck);
  if (hit) { try { return await hit.json(); } catch (e) {} }

  const [views, supply, voy, gp] = await Promise.all([
    pageviews(p.n).catch(() => null),
    wantSupply ? osmSupply(+p.la, +p.lo, env).catch(() => null) : Promise.resolve(null),
    wikivoyage(p.n).catch(() => null),
    env.GOOGLE_PLACES_KEY ? googleLookup(p, env).catch(() => null) : Promise.resolve(null)
  ]);

  const provenance = [];
  const rec = { name: p.n, retrieved_at: new Date().toISOString(), categories: {}, provenance };

  if (views) {
    rec.popularity = views;
    provenance.push({ source: "Wikimedia REST pageviews", licence: "CC0",
      url: "https://wikimedia.org/api/rest_v1/", retrieved_at: rec.retrieved_at });
  }
  if (voy) {
    rec.context = voy;
    provenance.push({ source: "Wikivoyage", licence: "CC BY-SA 4.0",
      url: voy.url, retrieved_at: rec.retrieved_at,
      detail: "narrative description and seasonality — not a rating" });
  }
  if (supply) {
    for (const k in supply.counts)
      rec.categories[k] = Object.assign(rec.categories[k] || {},
        { count: supply.counts[k], countSource: "OpenStreetMap (Overpass)" });
    provenance.push({ source: "OpenStreetMap contributors", licence: "ODbL",
      url: "https://www.openstreetmap.org/copyright", retrieved_at: rec.retrieved_at,
      detail: `feature counts within ${supply.radiusKm} km` });
  }

  /* Commercial adapters merge on top. Where two sources both have a
     rating they are combined by evidence weight rather than averaged
     one-for-one, and `sources` records how many agreed. */
  [gp].forEach(src => {
    if (!src || !src.overall) return;
    const o = src.overall;
    if (!rec.overall) { rec.overall = Object.assign({ sources: 1 }, o); }
    else {
      const A = rec.overall, B = o;
      const wa = Math.sqrt(A.reviews || 1), wb = Math.sqrt(B.reviews || 1);
      rec.overall = {
        rating: Math.round(((A.rating * wa + B.rating * wb) / (wa + wb)) * 1000) / 1000,
        reviews: (A.reviews || 0) + (B.reviews || 0),
        distribution: A.distribution || B.distribution || null,
        source: [A.source, B.source].filter(Boolean).join(" + "),
        sources: (A.sources || 1) + 1
      };
    }
    if (src.recency && !rec.recency) rec.recency = src.recency;
    for (const k in (src.categories || {}))
      rec.categories[k] = Object.assign(rec.categories[k] || {}, src.categories[k]);
    if (src.provenance) provenance.push(...src.provenance);
  });

  const res = json(rec, 200, { "Cache-Control": "public, max-age=1209600" });
  ctx.waitUntil(cache.put(ck, res.clone()));
  return rec;
}

/* ---- ATTENTION ---------------------------------------------------------
   Wikipedia pageviews. Free, keyless, CC0, and a genuinely good proxy for
   how much of the world is thinking about a place. It is NOT a rating and
   is never returned as one — it lands in `popularity` and stays there.

   Thirteen months, so the last quarter can be compared against the year
   before it and a trend falls out for nothing.                          */
async function pageviews(name) {
  const end = new Date(Date.now() - 3 * 864e5);            // the API lags a little
  const start = new Date(end.getTime() - 400 * 864e5);
  const stamp = d => d.toISOString().slice(0, 10).replace(/-/g, "") + "00";
  const title = await wikiTitle(name);
  if (!title) return null;

  const u = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/` +
            `all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/monthly/` +
            `${stamp(start)}/${stamp(end)}`;
  const r = await fetch(u, { headers: { "User-Agent": BOT_UA } });
  if (!r.ok) return null;
  const j = await r.json();
  const v = (j.items || []).map(x => x.views).filter(x => isFinite(x));
  if (v.length < 3) return null;

  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const recent = mean(v.slice(-3)), prior = mean(v.slice(-15, -3));
  return {
    monthly: Math.round(mean(v.slice(-12)) || mean(v)),
    trend: (recent != null && prior) ? Math.round((recent / prior - 1) * 100) / 100 : null,
    months: v.length, title,
    source: "Wikipedia pageviews (Wikimedia REST)"
  };
}

/* Destination names and article titles disagree often enough ("Salalah &
   Dhofar", "Kerala Backwaters") that asking search first is cheaper than
   handling the 404s. */
async function wikiTitle(name) {
  const q = String(name).replace(/\s*\(.*?\)/, "").split(/\s*[&·—]\s*/)[0].trim();
  if (!q) return null;
  try {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&format=json&` +
      `list=search&srlimit=1&srsearch=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": BOT_UA } });
    if (!r.ok) return q;
    const j = await r.json();
    const hit = j.query && j.query.search && j.query.search[0];
    return hit ? hit.title : q;
  } catch (e) { return q; }
}

/* ---- NARRATIVE CONTEXT -------------------------------------------------
   Wikivoyage: a free, CC BY-SA travel guide written by people who have
   been there. It is the best free answer to "what is this place actually
   like, and when should you go", and it is NOT a rating — this is the
   trap the whole design note warns about. An article being long means
   somebody enjoyed writing it. It says nothing about whether anybody
   enjoyed the trip, so nothing derived from this ever reaches the score.

   What it IS good for: the seasonality paragraph. Wikivoyage articles
   almost always contain a plain-English "when to go" section, and quoting
   that beside our modelled climate figure is more use to a traveller than
   either on its own.                                                     */
/* Records a refused upstream call in Workers Logs (Workers & Pages →
   waypoint → Observability; search for the event name). Never throws. */
async function logUpstream(event, step, subject, res) {
  let body = "";
  try { body = (await res.text()).slice(0, 160); } catch (e) {}
  console.warn(JSON.stringify({ event, step, subject, status: res.status,
    retryAfter: res.headers.get("Retry-After"), body }));
}

async function wikivoyage(name) {
  const q = String(name).replace(/\s*\(.*?\)/, "").split(/\s*[&·—]\s*/)[0].trim();
  if (!q) return null;
  const H = { headers: { "User-Agent": BOT_UA } };

  const sr = await fetch(`https://en.wikivoyage.org/w/api.php?action=query&format=json&` +
    `list=search&srlimit=1&srsearch=${encodeURIComponent(q)}`, H);
  if (!sr.ok) { await logUpstream("wikivoyage_upstream", "search", q, sr); return null; }
  const sj = await sr.json();
  const hit = sj.query && sj.query.search && sj.query.search[0];
  if (!hit) return null;

  const er = await fetch(`https://en.wikivoyage.org/w/api.php?action=query&format=json&` +
    `redirects=1&prop=extracts|info&inprop=url&explaintext=1&exchars=1500&` +
    `titles=${encodeURIComponent(hit.title)}`, H);
  if (!er.ok) { await logUpstream("wikivoyage_upstream", "extract", hit.title, er); return null; }
  const ej = await er.json();
  const page = ej.query && Object.values(ej.query.pages)[0];
  const text = page && page.extract;
  if (!text || text.length < 120) return null;

  /* Pull the sentences that actually talk about timing. A crude filter,
     deliberately: anything cleverer would start inventing meaning, and a
     wrong "best time to visit" is worse than none. */
  const season = text.split(/(?<=[.!?])\s+/)
    .filter(x => /\b(monsoon|season|winter|summer|spring|autumn|rains?|dry|humid|best time|avoid|peak|crowd)\b/i.test(x))
    .slice(0, 3).join(" ").slice(0, 420) || null;

  return {
    extract: text.slice(0, 900),
    seasonNotes: season,
    url: (page && page.fullurl) || `https://en.wikivoyage.org/wiki/${encodeURIComponent(hit.title)}`,
    source: "Wikivoyage", licence: "CC BY-SA 4.0",
    retrieved_at: new Date().toISOString()
  };
}

/* ---- SUPPLY ------------------------------------------------------------
   OpenStreetMap, via Overpass, counting how much of each category exists
   within reach. This is the honest free answer to "is there anything to
   do here?" and it is the ONLY thing OSM is asked for — it has no opinion
   about quality and is not asked to pretend otherwise.

   `out count` returns a tally rather than the features themselves, which
   is the difference between a few hundred bytes and several megabytes,
   and is why nine categories in one query is reasonable to ask for.     */
const OSM_CATS = [
  ["food",       '["amenity"~"^(restaurant|cafe|food_court)$"]'],
  ["culture",    '["tourism"~"^(museum|gallery)$"]'],
  ["culture2",   '["historic"~"^(castle|monument|ruins|archaeological_site|memorial|fort)$"]'],
  ["nature",     '["leisure"~"^(park|nature_reserve)$"]'],
  ["nature2",    '["natural"~"^(peak|waterfall|cave_entrance|hot_spring)$"]'],
  ["beaches",    '["natural"="beach"]'],
  ["nightlife",  '["amenity"~"^(bar|pub|nightclub)$"]'],
  ["family",     '["tourism"~"^(zoo|theme_park|aquarium)$"]'],
  ["shopping",   '["shop"~"^(mall|department_store)$"]'],
  ["shopping2",  '["amenity"="marketplace"]'],
  ["activities", '["tourism"="viewpoint"]'],
  ["activities2",'["leisure"~"^(water_park|sports_centre|golf_course)$"]'],
  ["wellness",   '["leisure"="spa"]']
];

async function osmSupply(la, lo, env) {
  const radiusKm = 30, r = radiusKm * 1000;
  const parts = OSM_CATS.map(([k, f], i) =>
    `nwr${f}(around:${r},${la.toFixed(4)},${lo.toFixed(4)})->.s${i};\n.s${i} out count;`);
  const q = `[out:json][timeout:25];\n${parts.join("\n")}`;

  const endpoint = env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), 20000);
  let j = null;
  try {
    const res = await fetch(endpoint, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "text/plain", "User-Agent": BOT_UA },
      body: q
    });
    if (!res.ok) return null;
    j = await res.json();
  } catch (e) { return null; } finally { clearTimeout(kill); }

  const counts = {};
  const els = (j.elements || []).filter(e => e.type === "count");
  if (els.length !== OSM_CATS.length) return null;          // order would be ambiguous
  OSM_CATS.forEach(([k], i) => {
    const total = +((els[i].tags || {}).total || 0);
    const base = k.replace(/\d$/, "");                      // culture2 folds into culture
    counts[base] = (counts[base] || 0) + (isFinite(total) ? total : 0);
  });
  return { counts, radiusKm, source: "OpenStreetMap (Overpass)" };
}

/* TRIPADVISOR WAS REMOVED, ON PURPOSE.

   It used to sit here: two calls per destination against the legacy
   Content API, returning a star rating, a review count and — the part
   that was genuinely worth having — subratings for food, culture, nature,
   beaches, nightlife, family, shopping, activities and wellness, mapped
   onto Waypoint's own category vocabulary.

   That API sunset on 31 August 2026 and was replaced by Tripadvisor's
   Terra platform. Rather than sign up to a metered commercial dependency
   with billing details and caching restrictions before launch, the
   adapter was deleted. The reputation layer already degrades honestly
   without it: Wikipedia pageviews, OpenStreetMap counts and Wikivoyage
   carry attention and supply, and the page says plainly that there are
   no star ratings rather than implying it has them.

   If traveller ratings are wanted later, this is the seam to write them
   into — one function returning {overall, categories, provenance}, added
   to the Promise.all in reputation(). That shape is the whole point of
   the adapter pattern and it survives the removal. */

/* ---- OPTIONAL: GOOGLE PLACES ------------------------------------------
   Off unless GOOGLE_PLACES_KEY is set. Pay-as-you-go with free monthly
   caps; billing must be enabled on the project. The field mask is
   deliberately minimal — rating, count and price level only — because
   Places bills by the fields you ask for, and asking for reviews or
   photos here would cost several times as much for data Waypoint gets
   free from Wikimedia.                                                  */
async function googleLookup(p, env) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_KEY,
      "X-Goog-FieldMask": "places.displayName,places.rating,places.userRatingCount,places.priceLevel"
    },
    body: JSON.stringify({
      textQuery: `${p.n}${p.co ? ", " + p.co : ""}`,
      locationBias: { circle: { center: { latitude: +p.la, longitude: +p.lo }, radius: 40000 } },
      maxResultCount: 1, languageCode: "en"
    })
  });
  if (!r.ok) return null;
  const j = await r.json();
  const g = j.places && j.places[0];
  if (!g || !isFinite(+g.rating) || !isFinite(+g.userRatingCount)) return null;
  return {
    overall: { rating: +g.rating, reviews: +g.userRatingCount, source: "Google Places" },
    categories: {},
    provenance: [{ source: "Google Places API", licence: "Google Maps Platform terms",
      retrieved_at: new Date().toISOString() }]
  };
}

/* Nominatim is a donated public service. It rate-limits hard, requires a
   genuine contact in the User-Agent, and is especially suspicious of
   datacentre IPs — which is exactly what a Worker is. So it will sometimes
   refuse us for reasons that have nothing to do with what the user typed.

   The old version collapsed every one of those outcomes into `[]`, and the
   app rendered `[]` as "No match — try adding the region or country." That
   is the worst possible message for the situation: it tells someone their
   spelling is wrong when the truth is that the geocoder never answered, so
   they retype a perfectly good city name and fail again. Emptiness and
   failure are different facts and are now reported as different facts.

   Open-Meteo's geocoder is the fallback: keyless, CORS-open, and already a
   credited Waypoint source, so search keeps working when Nominatim will
   not answer. Results from either are normalised to one shape so callers
   never have to care which one replied. */
function normNominatim(h) {
  if (!h) return null;
  const lat = +h.lat, lon = +h.lon;
  if (!isFinite(lat) || !isFinite(lon)) return null;
  const a = h.address || {};
  const dn = h.display_name || h.name || "";
  return {
    name: dn.split(",").slice(0, 2).join(",").trim() || h.name || "",
    display_name: dn, lat, lon,
    /* The state matters as much as the country. India declares most of
       its holidays at state level, so a traveller in Chennai and one in
       Guwahati should not see the same list. Nominatim returns the
       ISO 3166-2 code (for example "IN-TN") at one of several admin
       levels depending on the country, so all of them are tried, and
       the trailing part is kept because that is the form the holiday
       feeds use for their county codes. */
    address: {
      country_code: (a.country_code || "").toLowerCase(),
      country: a.country || "",
      state: a.state || a.province || a.region || "",
      region_code: String(a["ISO3166-2-lvl4"] || a["ISO3166-2-lvl3"] ||
                          a["ISO3166-2-lvl5"] || "").split("-").pop() || ""
    },
    /* WHAT KIND OF THING THIS IS — a city, a state, a country, a
       continent. Without it the page cannot tell "Asia" from a town, and
       once treated the continent's centre point as somewhere to fly to.
       Nominatim's own label, passed through untouched. Additive: nothing
       that reads this response before now looks at it. */
    kind: String(h.addresstype || h.type || "")
  };
}
function normOpenMeteo(r) {
  if (!r) return null;
  const lat = +r.latitude, lon = +r.longitude;
  if (!isFinite(lat) || !isFinite(lon)) return null;
  const bits = [r.name, r.admin1, r.country].filter(Boolean);
  return {
    name: [r.name, r.admin1].filter(Boolean).join(", "),
    display_name: bits.join(", "), lat, lon,
    /* Open-Meteo gives the admin area by name only, with no ISO code, so
       the name is passed through and the code left empty rather than
       guessed. A wrong state code would silently filter the wrong
       holidays, which is worse than filtering none. */
    address: { country_code: (r.country_code || "").toLowerCase(), country: r.country || "",
               state: r.admin1 || "", region_code: "" },
    /* Open-Meteo's GeoNames feature code: PCLI a country, ADM1 a state,
       CONT a continent, PPL* a populated place. Same purpose as above. */
    kind: String(r.feature_code || "")
  };
}

async function geocode(request, ctx, env) {
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").slice(0, 120);
  if (q.length < 3) return json({ results: [], source: null, reached: true }, 200);

  const cache = caches.default;
  const ck = new Request("https://waypoint.cache/geo/v3/" + encodeURIComponent(q.toLowerCase()));
  const hit = await cache.match(ck);
  if (hit) return hit;

  /* Nominatim's policy asks for a real contact address. `you@example.com`
     is not one, and an invalid contact is grounds for being blocked. Set
     CONTACT_EMAIL in the Worker's environment variables. */
  const contact = (env && env.CONTACT_EMAIL) || "admin@waypoint.holiday";
  const ua = `Waypoint/2.0 (travel decision engine; ${contact})`;

  let results = [], source = null, reached = false, upstream = null;

  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&accept-language=en&q=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": ua, "Accept": "application/json" } }
    );
    upstream = r.status;
    if (r.ok) {
      reached = true;
      const j = await r.json().catch(() => null);
      if (Array.isArray(j)) {
        const mapped = j.map(normNominatim).filter(Boolean);
        if (mapped.length) { results = mapped; source = "OpenStreetMap / Nominatim"; }
      }
    }
  } catch (e) { upstream = upstream || "network-error"; }

  if (!results.length) {
    try {
      const r2 = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=${encodeURIComponent(q)}`,
        { headers: { "Accept": "application/json" } }
      );
      if (r2.ok) {
        reached = true;
        const j2 = await r2.json().catch(() => null);
        const arr = (j2 && Array.isArray(j2.results)) ? j2.results : [];
        const mapped = arr.map(normOpenMeteo).filter(Boolean);
        if (mapped.length) { results = mapped; source = "Open-Meteo geocoding"; }
      }
    } catch (e) {}
  }

  const body = { results, source, reached, upstream_status: upstream, query: q };
  // Only a real answer is worth remembering for a month. Caching a failure
  // would turn a transient block into a month-long outage for that query.
  const res = json(body, 200, results.length
    ? { "Cache-Control": "public, max-age=2592000" }
    : { "Cache-Control": "no-store" });
  if (results.length) ctx.waitUntil(cache.put(ck, res.clone()));
  return res;
}


/* ---------- 12 · DESTINATION PHOTOGRAPHY --------------------------------
   GET /api/photo?n=<name>&cc=<CC>&lat=&lon=&f=<pinned Commons file>

   WHY THIS EXISTS

   index.html has always called this endpoint. It was never written, so
   every call returned 404, workerPhoto() returned null, and the browser
   quietly fell back to Wikipedia's lead image with a Commons text search
   behind it. That fallback is why destination photography has been
   unreliable: a text search for "Kochi India" returns whatever is named
   that, not what was photographed there.

   WHAT IT DOES DIFFERENTLY

   Four routes, then one answer:

     pinned     an editor chose this exact file. It wins outright — no
                scoring, no second-guessing. This is how waypoint-photos.js
                (written by photo-studio.html) reaches the page.
     near       Commons files geotagged within 10 km of the destination.
                A geotag is evidence; a filename is a claim. This route is
                the reason the endpoint is worth having.
     article    every image used on the place's Wikipedia article.
     search     Commons text search, name plus country — the old behaviour,
                kept as the last resort rather than the first.

   Everything is then filtered on the things that actually went wrong
   before: too small, portrait (the card is a landscape crop, so a tall
   photograph gets its subject cut off), a non-free or unstated licence,
   or a geotag more than 120 km from where the destination claims to be.

   The photographer and licence travel with the URL, so the page no longer
   makes a second round trip to find out who to credit — and cannot end up
   crediting one photographer beside another's photograph.

   COST: nothing. Wikimedia's APIs are free and keyless. One answer per
   destination is cached at the edge for 30 days, so the upstream sees a
   handful of calls a month rather than one per visitor. A destination
   with no acceptable photograph is cached as a refusal for a day, which
   stops a hopeless case being re-asked on every page load.
========================================================================= */
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKI_API    = "https://en.wikipedia.org/w/api.php";
const PHOTO_UA = { "User-Agent":
  BOT_UA };

/* Filenames that are reliably not a photograph of a place. Applied to the
   automatic routes only — a pinned file was chosen by a person and is
   never second-guessed, however it happens to be named. */
const PHOTO_JUNK = new RegExp([
  "flag","coat[ _]of[ _]arms","logo","icon","\\bmap\\b","locator","seal\\b","blank",
  "diagram","chart\\b","\\bgraph\\b","banner","stub","symbol","emblem","wikimedia",
  "commons-logo","topographic","plan[ _]of","escudo","bandera","wappen","drapeau",
  "orthographic","\\bcrest\\b","signature","postage","stamp\\b","coin\\b","banknote",
  "timeline","population","climate[ _]chart"
].join("|"), "i");

const PHOTO_II = {
  prop: "imageinfo|coordinates",
  iiprop: "url|size|mime|extmetadata",
  iiextmetadatafilter: "Artist|Credit|LicenseShortName|ImageDescription",
  colimit: "max"
};
/* The same, plus a rendered thumbnail URL. Asked for only when a file has
   actually won, never while listing thirty candidates — iiurlwidth makes
   MediaWiki render every thumbnail in the response. */
const PHOTO_II_URL = Object.assign({ iiurlwidth: 1600 }, PHOTO_II);

async function wmQuery(base, params, ms) {
  const u = new URL(base);
  for (const k in params) u.searchParams.set(k, params[k]);
  u.searchParams.set("format", "json");
  u.searchParams.set("formatversion", "2");
  const r = await raced(fetch(u.toString(), { headers: PHOTO_UA }), ms || 7000);
  if (!r.ok) throw new Error("wikimedia " + r.status);
  return r.json();
}
/* One spelling for a filename, so "File:A_b.jpg" and "A b.jpg" are the
   same photograph when checking a refusal list. */
const photoKey = s => String(s || "")
  .replace(/^File:/i, "").replace(/_/g, " ").trim().toLowerCase();
const photoStrip = h => String(h || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/* Commons' Artist field is free text. Most photographers put their name in
   it; some paste a whole permission notice. Take the name, leave the essay.
   Deliberately the same trimming index.html does, so a credit rendered from
   this endpoint reads identically to one the browser worked out itself. */
function photoAuthor(raw) {
  let t = photoStrip(raw);
  if (!t) return "";
  const stop = t.search(/\s(?:feel free|please\b|you may\b|if you\b|licen[cs]ed under|permission|attribution:|source:|no changes|do not\b)/i);
  if (stop > 0) t = t.slice(0, stop);
  t = t.replace(/^(?:this\s+(?:photo|photograph|image|file)\s+(?:was\s+)?(?:taken|created|made)\s+by|photo(?:graph)?\s+by|image\s+by|©|\(c\))\s*/i, "");
  t = t.replace(/[\s.,;:|]+$/, "").trim();
  return t.length > 70 ? t.slice(0, 67).trim() + "…" : t;
}
function photoKm(aLat, aLon, bLat, bLon) {
  const D = Math.PI / 180, dLa = (bLat - aLat) * D, dLo = (bLon - aLon) * D;
  const q = Math.sin(dLa / 2) ** 2 +
            Math.cos(aLat * D) * Math.cos(bLat * D) * Math.sin(dLo / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(q));
}
/* The width-limited Commons redirect used by the homepage hero images.
   Kept as a last resort only: it renders in an <img> but cannot be fetched
   with CORS, so anything that needs to read the pixels — the PDF cover —
   must be given a upload.wikimedia.org URL instead. See photoDeliverable. */
const photoURL = (file, width) =>
  "https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/" +
  encodeURIComponent(file) + "&width=" + width;

/* One Commons page → a candidate, or null if it fails the bar.
   `trust` is set for a pinned file: existence and format are still checked,
   because a typo in waypoint-photos.js should not blank the card, but
   judgement about whether it is a good photograph is not ours to make. */
function photoShape(page, trust) {
  const ii = page && page.imageinfo && page.imageinfo[0];
  if (!ii) return null;
  const file = String(page.title || "").replace(/^File:/i, "");
  if (!/\.(jpe?g|png)$/i.test(file)) return null;
  if (!/^image\/(jpeg|png)$/i.test(ii.mime || "")) return null;

  const w = ii.width || 0, h = ii.height || 0;
  const ratio = h ? +(w / h).toFixed(2) : 0;
  const meta = ii.extmetadata || {};
  const licence = photoStrip(meta.LicenseShortName && meta.LicenseShortName.value);

  if (!trust) {
    if (PHOTO_JUNK.test(file)) return null;
    if (w < 1200) return null;                       // the card is 1600 wide on a retina screen
    if (ratio < 1.15) return null;                   // portrait loses its subject to the crop
    // Commons is free-content only, but a file can still arrive with its
    // licence unstated. Showing a photograph we cannot name a licence for
    // is the one failure mode there is no excuse for.
    if (!licence || /non-?free|fair use|all rights reserved/i.test(licence)) return null;
  } else if (w < 600) return null;

  const co = (page.coordinates && page.coordinates[0]) || null;
  return {
    file,
    thumb: ii.thumburl || "",       // upload.wikimedia.org, when asked for
    origin: ii.url || "",           // upload.wikimedia.org, full size
    url: photoURL(file, 1600),      // replaced by photoDeliverable() below
    fallback: photoURL(file, 1200),
    page: ii.descriptionurl ||
      "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(file.replace(/ /g, "_")),
    width: w, height: h, ratio,
    author: photoAuthor(meta.Artist && meta.Artist.value) ||
            photoAuthor(meta.Credit && meta.Credit.value) || "",
    licence: licence || "",
    description: photoStrip(meta.ImageDescription && meta.ImageDescription.value).slice(0, 200),
    lat: co ? co.lat : null,
    lon: co ? co.lon : null,
    via: []
  };
}
/* Merge, so a photograph found by three routes appears once and carries
   all three. Agreement between differently-biased routes is a signal and
   is scored as one. */
function photoCollect(j, tag, out) {
  const pages = (j && j.query && j.query.pages) || [];
  for (const p of pages) {
    const c = photoShape(p, false);
    if (!c) continue;
    const seen = out.find(x => x.file === c.file);
    if (seen) { if (!seen.via.includes(tag)) seen.via.push(tag); continue; }
    c.via.push(tag);
    out.push(c);
  }
}
function photoScore(c) {
  let s = 0;
  if (c.via.includes("near"))    s += 3.2;
  if (c.via.includes("lead"))    s += 2.4;
  if (c.via.includes("article")) s += 1.8;
  if (c.distance_km != null) {
    if (c.distance_km <= 5) s += 1.4;
    else if (c.distance_km <= 15) s += 0.7;
    else if (c.distance_km > 60) s -= 1.2;
  }
  if (c.ratio >= 1.3 && c.ratio <= 2.1) s += 1.1;   // sits well in a 16:9 crop
  s += Math.min(c.width / 2400, 1.2);
  if (c.via.length > 1) s += 0.6;
  return s;
}

/* WHICH URL TO HAND THE BROWSER, AND WHY IT IS NOT THE OBVIOUS ONE.

   Commons' width-limited redirect (Special:Redirect/file/…) is documented
   for hotlinking and displays perfectly in an <img>. It is still the wrong
   answer here, and the trip dossier is what proved it: the PDF re-fetches
   the cover photograph with mode "cors" — it has to, because a canvas that
   touches an image loaded without CORS is tainted for ever and cannot be
   read back. commons.wikimedia.org does not send an Access-Control-Allow-
   Origin header, and every hop of a redirect chain has to pass that check,
   so the fetch failed and every dossier fell back to its drawn cover while
   the page above it showed the photograph perfectly. A URL that works in
   one context and silently fails in the other is worse than a slow one.

   upload.wikimedia.org does send the header. So the answer is the rendered
   thumbnail URL, which also saves the browser a redirect. The redirect form
   stays in the response as `redirect`, because it is the durable address of
   the file and useful to anything that only needs to display it. */
async function photoDeliverable(c) {
  if (!c.thumb) {
    try {
      const j = await wmQuery(COMMONS_API,
        Object.assign({ action: "query", titles: "File:" + c.file }, PHOTO_II_URL));
      const ii = ((j.query && j.query.pages && j.query.pages[0]) || {}).imageinfo;
      if (ii && ii[0]) { c.thumb = ii[0].thumburl || ""; c.origin = ii[0].url || c.origin; }
    } catch (e) { /* fall back to the redirect below */ }
  }
  const t = c.thumb || "";
  c.redirect = photoURL(c.file, 1600);
  c.url = t || c.origin || c.redirect;
  /* MediaWiki thumbnails are named <width>px-<file>, so a second size costs
     nothing. When the original is narrower than 1600 there is no thumbnail
     to rename and the original — already CORS-safe — is the fallback. */
  c.fallback = /\/1600px-/.test(t) ? t.replace("/1600px-", "/1200px-")
             : (c.origin || photoURL(c.file, 1200));
  return c;
}

async function photo(request, ctx, env) {
  const u = new URL(request.url);
  const name = cleanToken(u.searchParams.get("n"), 120);
  const cc   = cleanToken(u.searchParams.get("cc"), 2).toUpperCase();
  const lat  = +u.searchParams.get("lat"), lon = +u.searchParams.get("lon");
  const pin  = cleanToken(decodeOnceIfEncoded(u.searchParams.get("f") || ""), 240)
                 .replace(/^File:/i, "");
  /* Photographs the traveller has already been shown and pressed the reload
     button on. This is what lets ↻ ask for the NEXT choice instead of
     abandoning the Worker: a refusal is information, and throwing it away is
     what made every reload fall through to the unvetted text search. Capped
     at eight, so the cache cannot be fragmented without limit and a
     determined reloader eventually runs out honestly. */
  const skip = new Set(
    cleanToken(decodeOnceIfEncoded(u.searchParams.get("skip") || ""), 1400)
      .split("|").map(photoKey).filter(Boolean).slice(0, 8));
  if (!name) return json({ ok: false, error: "n required" }, 400);

  const cache = caches.default;
  const ck = new Request("https://waypoint.cache/photo/v2/" +
    encodeURIComponent(name) + "/" +
    (isFinite(lat) ? lat.toFixed(2) : "x") + "," + (isFinite(lon) ? lon.toFixed(2) : "x") +
    "/" + encodeURIComponent(pin || "auto") +
    "/" + (skip.size ? encodeURIComponent([...skip].sort().join("|")).slice(0, 300) : "0"));
  const hit = await cache.match(ck);
  if (hit) return hit;

  const finish = (body, ttl) => {
    const res = json(body, 200, { "Cache-Control": "public, max-age=" + ttl });
    ctx.waitUntil(cache.put(ck, res.clone()));
    return res;
  };
  const answer = (c, ttl) => finish({
    ok: true,
    url: c.url,
    fallback: c.fallback,
    redirect: c.redirect || photoURL(c.file, 1600),
    file: c.file,
    page: c.page,
    source: c.page,
    author: c.author,
    credit: c.author,
    licence: c.licence,
    license: c.licence,          // both spellings, so the page cannot miss it
    description: c.description,
    width: c.width, height: c.height, ratio: c.ratio,
    distance_km: c.distance_km == null ? null : c.distance_km,
    via: c.via.join("+"),
    remaining: c.remaining == null ? null : c.remaining,
    pinned: c.via.includes("pinned"),
    provider: "Wikimedia Commons",
    licence_note: "Each file carries its own licence. The file page is the authority.",
    retrieved_at: new Date().toISOString()
  }, ttl);

  /* ── 1 · A PINNED FILE WINS ─────────────────────────────────────────
     Someone looked at this destination and chose this photograph. The
     only question left is whether the file still exists. */
  if (pin && !skip.has(photoKey(pin))) {
    try {
      const j = await wmQuery(COMMONS_API,
        Object.assign({ action: "query", titles: "File:" + pin }, PHOTO_II_URL));
      const pg = j.query && j.query.pages && j.query.pages[0];
      const c = pg && !pg.missing ? photoShape(pg, true) : null;
      if (c) {
        c.via = ["pinned"];
        c.distance_km = (c.lat != null && isFinite(lat))
          ? Math.round(photoKm(lat, lon, c.lat, c.lon)) : null;
        return answer(await photoDeliverable(c), 2592000);
      }
    } catch (e) { /* fall through and choose automatically */ }
    /* A pin that no longer resolves is a broken reference, not a reason to
       show nothing. Carry on, and say so in the answer below. */
  }

  /* ── 2 · CHOOSE AUTOMATICALLY ───────────────────────────────────── */
  const country = cc ? REGION_NAMES(cc) : "";
  const plain = name.replace(/\s*\(.*?\)/, "").trim();
  const out = [];

  const nearby = async () => {
    if (!isFinite(lat) || !isFinite(lon)) return;
    const j = await wmQuery(COMMONS_API, Object.assign({
      action: "query", generator: "geosearch",
      ggscoord: lat + "|" + lon, ggsradius: 10000, ggslimit: 30, ggsnamespace: 6
    }, PHOTO_II));
    photoCollect(j, "near", out);
  };

  const fromArticle = async () => {
    const j = await wmQuery(WIKI_API, {
      action: "query", redirects: 1, generator: "search",
      gsrsearch: plain + (country ? " " + country : ""), gsrlimit: 1,
      prop: "pageimages|images", piprop: "thumbnail", pithumbsize: 1600, imlimit: 40
    });
    const page = (j.query && j.query.pages && j.query.pages[0]) || null;
    if (!page) return;
    const titles = (page.images || []).map(i => i.title)
      .filter(t => /\.(jpe?g|png)$/i.test(t) && !PHOTO_JUNK.test(t)).slice(0, 40);
    if (titles.length) {
      const k = await wmQuery(COMMONS_API,
        Object.assign({ action: "query", titles: titles.join("|") }, PHOTO_II));
      photoCollect(k, "article", out);
    }
    /* Wikipedia's own lead image is worth knowing about — it is usually the
       article's best photograph, chosen by editors rather than by a search
       engine — but it is promoted, not obeyed. */
    const lead = page.thumbnail && page.thumbnail.source;
    if (lead) {
      const m = /\/([^\/]+)$/.exec(decodeURIComponent(lead.split("?")[0]));
      if (m) {
        const guess = m[1].replace(/^\d+px-/, "").replace(/ /g, "_");
        const hitLead = out.find(c => c.file.replace(/ /g, "_") === guess);
        if (hitLead && !hitLead.via.includes("lead")) hitLead.via.push("lead");
      }
    }
  };

  const byName = async () => {
    const j = await wmQuery(COMMONS_API, Object.assign({
      action: "query", generator: "search",
      gsrsearch: plain + (country ? " " + country : ""),
      gsrnamespace: 6, gsrlimit: 30
    }, PHOTO_II));
    photoCollect(j, "search", out);
  };

  const settled = await Promise.allSettled([nearby(), fromArticle(), byName()]);
  const allFailed = settled.every(r => r.status === "rejected");

  for (const c of out) {
    c.distance_km = (c.lat != null && isFinite(lat))
      ? Math.round(photoKm(lat, lon, c.lat, c.lon)) : null;
  }
  /* A geotag that disagrees with the atlas by more than 120 km is not this
     place. Files without a geotag are kept — most photographs have none,
     and absence of evidence is not evidence of the wrong continent. */
  const keep = out.filter(c =>
    !skip.has(photoKey(c.file)) && (c.distance_km == null || c.distance_km <= 120));
  keep.forEach(c => { c.score = photoScore(c); });
  keep.sort((a, b) => b.score - a.score);

  if (keep.length) {
    const best = keep[0];
    best.remaining = keep.length - 1;      // is ↻ worth pressing again?
    if (pin && !skip.has(photoKey(pin))) best.pin_unresolved = pin;
    return answer(await photoDeliverable(best), 2592000);
  }
  /* Nothing good. Said plainly, and cached briefly so a hopeless
     destination is not re-asked on every page load. index.html reads a
     falsy `ok` as "choose for yourself" and its own path still runs. */
  return finish({
    ok: false,
    error: allFailed ? "wikimedia unreachable"
         : skip.size ? "nothing left that has not been refused"
         : "no photograph met the bar",
    exhausted: !allFailed && skip.size > 0,
    checked: out.length,
    name,
    pin_unresolved: pin || null,
    retrieved_at: new Date().toISOString()
  }, allFailed ? 300 : 86400);
}


/* =====================================================================
   worker.js  ·  /api/fares   — CORRECTED VERSION
   ---------------------------------------------------------------------
   Replaces the earlier snippet, which was written against a house style
   this Worker does not use. Three things were wrong with it:

     · it called corsHeaders(request), which does not exist here. CORS is
       handled centrally in fetch() and by the json() helper.
     · it took (ctx) and read ctx.request and ctx.env. In this Worker ctx
       is the Cloudflare execution context and carries neither. Endpoints
       that need the request take (request, ctx, env), as holidays() does.
     · it built Responses by hand instead of using json().

   Left alone it would have thrown a ReferenceError on every call — which
   the client would have read as "no live fare" and silently fallen back
   to the modelled curve, so nothing would have looked broken and nothing
   would have worked either.

   WHAT IT DOES. Returns the cheapest cached RETURN fares for one route
   and one month from the Travelpayouts (Aviasales) Data API, so the
   budget shown for the destination on screen can be sharpened with real
   prices instead of a curve.

   WHY IT MUST NOT BE CALLED WHILE RANKING. A single search scores up to
   490 destinations. Calling this once per destination would be 490 Worker
   requests and 490 upstream calls for one page view, which would exhaust
   the 100,000-a-day free allowance at about 200 searches. Called once for
   the destination actually being read, it is one request per view and the
   allowance is irrelevant. This is the same rule the weather endpoint
   already follows: a live reading refines a model, it does not replace
   one, and the ranking must stay deterministic and offline anyway or the
   same search would return different orders on different days.

   WHAT COMES BACK IS THE CHEAPEST FARE, NOT A TYPICAL ONE. The uplift
   that turns one into the other lives in waypoint-prices.js (P.UPLIFT),
   applied by P.liveFare, so that the live path and the modelled path
   produce numbers that mean the same thing.
===================================================================== */

const FARES_DAILY_MAX = 2000;     // upstream calls per day
const FARES_TTL       = 604800;   // 7 days, matching the upstream cache age

async function fares(request, ctx, env) {
  const u = new URL(request.url);

  /* Every failure returns ok:false with HTTP 200. The client must read a
     missing fare as "use the model", never as a broken page, and a 4xx
     would show up as an error in the browser console for something that
     is a perfectly normal outcome. */
  const no = reason => json({ ok: false, reason });

  const origin = String(u.searchParams.get("o") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  const dest   = String(u.searchParams.get("d") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  const month  = String(u.searchParams.get("m") || "").slice(0, 7);
  /* Point of sale. The API defaults to the Russian market, which prices a
     Bengaluru departure the way a Moscow travel agent would. The client
     passes the traveller's own country so the fares are the ones they can
     actually buy. */
  const mkt = String(u.searchParams.get("mkt") || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 2);

  if (origin.length !== 3 || dest.length !== 3) return no("need two 3-letter IATA codes");
  if (!/^\d{4}-\d{2}$/.test(month))             return no("need a month as YYYY-MM");
  if (origin === dest)                          return no("same airport");
  if (!env.TRAVELPAYOUTS_TOKEN)                 return no("no token configured");

  /* ---- DIAGNOSTIC MODE ----------------------------------------------
     &debug=1 runs the same route through several parameter combinations
     and reports how many quotes each one returns. It exists because the
     parameters that ought to WIDEN the result set turned out to narrow it
     to nothing, and guessing which one did that from the outside would
     have taken half a dozen round trips.

     Uncached on purpose, and it makes several upstream calls, so it is a
     one-off tool rather than something to leave wired into a page. */
  if (u.searchParams.get("debug") === "1") {
    const weeks = Math.max(1, Math.min(4, Math.round((+u.searchParams.get("days") || 7) / 7)));
    const base = `origin=${origin}&destination=${dest}&currency=usd`;
    const mm = "https://api.travelpayouts.com/v2/prices/month-matrix?" + base + `&month=${month}-01`;
    const v3 = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + base + `&departure_at=${month}`;

    const variants = [
      ["month-matrix, as originally shipped",       mm + "&show_to_affiliates=true"],
      ["month-matrix, all affiliates' prices",      mm + "&show_to_affiliates=false"],
      ["month-matrix + one_way=false",              mm + "&show_to_affiliates=true&one_way=false"],
      ["month-matrix + trip_duration",              mm + `&show_to_affiliates=true&one_way=false&trip_duration=${weeks}`],
      ["month-matrix + market",                     mm + `&show_to_affiliates=true&market=${mkt || "in"}`],
      ["month-matrix, everything at once",          mm + `&show_to_affiliates=false&one_way=false&trip_duration=${weeks}&market=${mkt || "in"}`],
      ["v3 prices_for_dates, one way",              v3 + "&one_way=true&limit=30&sorting=price"],
      ["v3 prices_for_dates, return",               v3 + "&one_way=false&limit=30&sorting=price"],

      /* The four below ignore the month on purpose.

         month-matrix and prices_for_dates both ask "what did people find
         for THIS route in THIS month". On a thin route the honest answer
         is nothing, because the cache is built from real searches on
         Aviasales and nobody searches Bengaluru to Dharamshala there.

         These ask a looser question instead: has this route ever been
         priced at all, in any month? A figure from March is not a fare
         for October, but it is a real observation of what the route costs,
         which beats a pure model. If any of these come back with quotes,
         the route is knowable and only the month was too narrow.        */
      ["latest, this month",                        `https://api.travelpayouts.com/v2/prices/latest?${base}&period_type=month&page=1&limit=30&show_to_affiliates=false&sorting=price`],
      ["latest, any month, one way",                `https://api.travelpayouts.com/v2/prices/latest?${base}&period_type=year&page=1&limit=30&show_to_affiliates=false&sorting=price&one_way=true`],
      ["latest, any month, return",                 `https://api.travelpayouts.com/v2/prices/latest?${base}&period_type=year&page=1&limit=30&show_to_affiliates=false&sorting=price&one_way=false`],
      ["cheap, any date",                           `https://api.travelpayouts.com/v1/prices/cheap?${base}`]
    ];

    const results = [];
    for (const [label, url] of variants) {
      try {
        const r = await fetch(url, {
          headers: { "X-Access-Token": env.TRAVELPAYOUTS_TOKEN, "Accept": "application/json" }
        });
        if (!r.ok) { results.push({ label, http: r.status, n: 0 }); continue; }
        const j = await r.json();
        const data = Array.isArray(j && j.data) ? j.data : [];
        const s0 = data[0] || null;
        results.push({
          label, http: 200, n: data.length,
          sample: s0 ? {
            value: s0.value,
            depart: s0.depart_date || s0.departure_at || null,
            ret: s0.return_date || s0.return_at || "",
            stops: s0.number_of_changes != null ? s0.number_of_changes : s0.transfers,
            cls: s0.trip_class
          } : null
        });
      } catch (err) {
        results.push({ label, error: err.message, n: 0 });
      }
    }
    return json({ ok: true, debug: true, route: origin + "-" + dest, month, market: mkt || "(none)", results });
  }

  /* Edge cache, keyed on the only three things that change the answer, so
     every visitor asking about the same route and month shares one
     upstream call worldwide. */
  const cache = caches.default;
  /* The version in the key is not decoration. v1 cached one-way prices that
     were being read as returns; v2 cached empty responses produced by a
     broken request. Both would otherwise have sat there for a week looking
     like facts about the world. Bump it on every change to what is asked
     for or how the answer is built. */
  const ck = new Request(`https://waypoint.cache/fares/v3/${origin}-${dest}-${month}-${mkt||"xx"}`);
  const hit = await cache.match(ck);
  if (hit) return hit;

  /* A daily ceiling, so a loop left running cannot run up a bill. One KV
     read and at most one write per uncached call — the free plan allows
     1,000 KV writes a day, which is why this counts by day and nothing
     finer. If KV is missing we carry on: this is a safety net, not a gate. */
  if (env.RATE) {
    try {
      const key = "fares:" + new Date().toISOString().slice(0, 10);
      const used = +(await env.RATE.get(key) || 0);
      if (used >= FARES_DAILY_MAX) return no("daily ceiling reached");
      await env.RATE.put(key, String(used + 1), { expirationTtl: 172800 });
    } catch (err) {
      console.warn("[fares] rate counter unavailable, carrying on:", err.message);
    }
  }

  /* month-matrix gives the cheapest fare for each departure day of the
     month. The spread across days is worth more than any single day's
     number, because it says whether a route is volatile. */
  /* WHAT THE PARAMETERS ACTUALLY DO, established by running eight
     combinations against one route and reading the results rather than the
     documentation alone:

       one_way        Defaults to TRUE. The 29-quote responses all carry
                      return_date:"" — they are one-way fares. Reading them
                      as returns is what made every fare look half price.

       one_way=false  Gives genuine return fares, and almost none of them:
                      one quote against twenty-nine. month-matrix groups by
                      number of transfers, and with returns that collapses.

       trip_duration  A stay length in WEEKS. Setting it took a working
                      route from 29 quotes to zero. It is not used.

       show_to_affiliates
                      Made no difference on the route tested, so it is set
                      to false anyway: all prices rather than only those
                      found through an affiliate marker.

       market         Defaults to ru, which prices a Bengaluru departure the
                      way it sells in Moscow. Set to the traveller's own
                      country it returned $38 where the default returned $40.

       limit          Days of the month to return. Defaults to 30, so a
                      31-day month silently loses its last day.

     SO WE ASK TWICE. The one-way call gives a real distribution across the
     month; the return call gives a small number of exact round-trip quotes.
     The one-way median doubled is the estimate, and the return quotes are
     carried alongside as a check on that doubling:

       BLR-GOI, October     one-way median $45, doubled $90
                            the one real return quote      $96
                            what was actually booked       $91          */
  /* EXACTLY THE CALL THAT WAS PROVEN TO WORK, and nothing more.

     After the diagnostic run returned 29 quotes, four things were added on
     top of it and all four went in untested. Together they returned zero,
     and there was no way to tell which was responsible, because a thrown
     error was being swallowed into an empty array and reported as "0 quotes
     cached for this route" — a sentence about the cache describing a fault
     in our own request. All four are gone:

       limit=31          The documentation says a 31-day month needs it.
                         Nothing demonstrated that, and the working run did
                         not send it. Losing one day of a month is a rounding
                         error; losing the whole month is not.

       Accept-Encoding   A known Workers footgun. Set it by hand and the body
                         can arrive still compressed, so res.json() throws.
                         The runtime handles compression on its own.

       cf: cacheEverything
                         Untested on this endpoint, and unnecessary: the
                         7-day edge cache above already does the job.

       User-Agent        Harmless, but it was not in the working call either,
                         and this is not the moment for untested extras.    */
  const common = `origin=${origin}&destination=${dest}&currency=usd`
    + `&month=${month}-01&show_to_affiliates=false`
    + (mkt ? `&market=${mkt}` : "");
  const MM = "https://api.travelpayouts.com/v2/prices/month-matrix?";

  async function pull(url){
    const res = await fetch(url, {
      headers: { "X-Access-Token": env.TRAVELPAYOUTS_TOKEN, "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (j && j.success === false) throw new Error("api: " + (j.error || "unknown"));
    return Array.isArray(j && j.data) ? j.data : [];
  }

  /* The two calls are made in sequence rather than in parallel so a failure
     in the first is reported as a failure rather than as an absence. */
  let oneWayRows = [], returnRows = [], oneWayErr = null, returnErr = null;
  try { oneWayRows = await pull(MM + common); }
  catch (err) { oneWayErr = err.message; console.error("[fares] one-way leg:", err.message); }

  try { returnRows = await pull(MM + common + "&one_way=false"); }
  catch (err) { returnErr = err.message; console.warn("[fares] return leg:", err.message); }

  /* An error and an empty cache are different things and must not share a
     message. The first is ours to fix; the second is simply how thin routes
     behave. */
  if (oneWayErr) return no("upstream request failed: " + oneWayErr);

  /* trip_class 0 is economy. Anything found more than 60 days ago is
     dropped — a stale quote is worse than no quote, because the model it
     would override is at least current. */
  const now = Date.now();
  const clean = rows => rows
    .filter(r => r && +r.value > 0 && +r.trip_class === 0)
    .filter(r => {
      if (!r.found_at) return true;
      const age = (now - Date.parse(r.found_at)) / 86400000;
      return isFinite(age) ? age <= 60 : true;
    })
    .map(r => +r.value)
    .sort((a, b) => a - b);

  const one = clean(oneWayRows), ret = clean(returnRows);

  if (one.length < 3) {
    /* This used not to be cached, on the reasoning that an empty answer was
       as likely to mean we had asked badly as that the route was thin.

       That was worth assuming until it was tested. Running BLR-DHM, BLR-IXC
       and BLR-UDR through twelve different query shapes each — including
       three that ignore the month entirely and ask whether the route has
       EVER been priced — returned 36 responses, all HTTP 200, and one
       single quote between them. We are not asking badly. Travelpayouts
       serves a cache built from real searches on Aviasales, and nobody
       searches Bengaluru to Udaipur there.

       So the absence is a fact about the route, and re-asking on every
       single visit spends the daily ceiling on a question already answered.
       Cached for a day: long enough to stop the waste, short enough that a
       route which starts getting searched is picked up within 24 hours. */
    const thin = json({ ok: false,
      reason: "only " + one.length + " quote(s) cached for this route",
      rawRows: oneWayRows.length, returnLegError: returnErr || null },
      200, { "Cache-Control": "public, max-age=86400" });
    ctx.waitUntil(cache.put(ck, thin.clone()));
    return thin;
  }

  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

  /* WHICH NUMBER TO BELIEVE, measured against fares booked by hand:

       route      doubled one-way    real return quotes    booked
       BLR-GOI    $90  (-1%)         $96  (+5%)            $91
       BLR-BKK    $328 (+10%)        $307 (+3%)            $297
       BOM-CDG    $490 (-11%)        $562 (+2%)            $551

     Real round-trip quotes win whenever there are enough of them to have a
     middle — they are actual itineraries rather than an assumption that a
     return costs twice a one-way. Below three quotes the doubled one-way
     distribution is steadier, because one quote is an anecdote.

     Both are reported either way, so the choice stays auditable. */
  const RETURN_MIN = 3;
  const useQuotes = ret.length >= RETURN_MIN;
  const mid   = useQuotes ? q(ret, 0.50) : q(one, 0.50) * 2;
  const p25   = useQuotes ? q(ret, 0.25) : q(one, 0.25) * 2;
  const p75   = useQuotes ? q(ret, 0.75) : q(one, 0.75) * 2;
  const low   = useQuotes ? ret[0]       : one[0] * 2;

  const body = json({
    ok: true,
    returnMedian: Math.round(mid),
    returnP25:    Math.round(p25),
    returnP75:    Math.round(p75),
    returnLow:    Math.round(low),
    /* Which of the two the headline came from, and how much evidence sat
       behind it. The client widens its uncertainty when this says
       "doubled", because an assumption is not an observation. */
    basis: useQuotes ? "return-quotes" : "one-way-doubled",
    n: useQuotes ? ret.length : one.length,
    returnQuotes: ret.slice(0, 8),
    nReturn: ret.length,
    nOneWay: one.length,
    oneWayMedian: Math.round(q(one, 0.50)),
    currency: "usd",
    month,
    route: origin + "-" + dest,
    market: mkt || "default",
    returnLegError: returnErr || null,
    source: "travelpayouts aviasales cache",
    note: "cheapest cached fares. basis says whether the headline is real round-trip quotes or a doubled one-way median. The booking uplift is applied client-side in P.liveFare."
  }, 200, { "Cache-Control": "public, max-age=259200" });

  ctx.waitUntil(cache.put(ck, body.clone()));
  return body;
}
