import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  Lock, Users, Scissors, Calendar, Check, X, Star, Minus, MapPin, Bed,
  Wallet, ChevronRight, AlertCircle, Loader2, RefreshCw, BadgeCheck, Volume2,
} from "lucide-react";

/* ============================================================================
   INTEGRATION MAP — what each sponsor API feeds, and where it lands in the UI.

   Stay22 Direct Travel API   -> Stays tab. Live inventory + per-supplier prices.
   Tavily                     -> `verified` badge + source link on activities.
   ElevenLabs                 -> speakDiff(), the spoken re-plan summary.
   AeroXplorer                -> disruption banner (news feed, not flight status).
   LLM (one call, at create)  -> the activity pool. Never called again.

   Everything the day-slider touches is local and deterministic. The only
   network call triggered by a re-plan is Stay22, and it is debounced.
   ==========================================================================*/

/* ---------------------------------------------------------------------------
   STAY22 — GET https://api.stay22.com/v2/accommodations
   Docs: dev.stay22.com/docs/api/accommodations/search

   Things that bit us and are now handled:
   - suppliers is a MAP (booking | expedia | hotelscom | vrbo), each with its
     own price.total. Different suppliers quote different prices for the same
     property. We surface the spread instead of hiding it.
   - price.total is the WHOLE STAY, not per night. meta.nights divides it.
   - rating.value is out of 10, not 5.
   - Demo mode needs no key but allows 5 req/min. Debounce + cache + fallback.
   - Do not persist listings. Stay22 forbids cold-storing. Keep in memory only.
   - `url` is the tracked Allez link. Send users there, not to the supplier
     directly, or the commission does not attribute.
-------------------------------------------------------------------------- */

const STAY22 = {
  base: "https://api.stay22.com/v2/accommodations",
  apiKey: null,   // set for higher limits; null runs demo mode
  aid: null,      // affiliate id for commission attribution
};

function normalizeStay(raw, nights) {
  const suppliers = Object.entries(raw.suppliers || {})
    .map(([name, s]) => ({
      name,
      total: s.price?.total ?? null,
      perNight: s.price?.total ? Math.round(s.price.total / nights) : null,
      link: s.link,
      logo: s.media?.logoSquare,
    }))
    .filter((s) => s.total != null)
    .sort((a, b) => a.total - b.total);

  const best = suppliers[0] || null;
  const worst = suppliers[suppliers.length - 1] || null;

  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    thumbnail: raw.media?.thumbnail || null,
    lat: raw.location?.coordinates?.lat,
    lng: raw.location?.coordinates?.lng,
    address: raw.location?.address || "",
    rating: raw.rating?.value ?? null,      // 0-10
    stars: raw.rating?.hotelStars ?? null,
    reviews: raw.rating?.count ?? 0,
    guests: raw.capacity?.guests ?? null,
    bedrooms: raw.capacity?.bedrooms ?? null,
    freeCancellation: !!raw.policies?.freeCancellation,
    suppliers,
    best,
    spread: best && worst ? worst.total - best.total : 0,
    source: "stay22",
  };
}

async function searchStays({ bbox, checkin, checkout, adults, currency, signal }) {
  const q = new URLSearchParams({
    nelat: bbox.nelat, nelng: bbox.nelng, swlat: bbox.swlat, swlng: bbox.swlng,
    checkin, checkout, adults: String(adults), rooms: "1",
    currency, pageSize: "12", minratingcount: "5",
  });
  if (STAY22.aid) q.set("aid", STAY22.aid);

  const res = await fetch(`${STAY22.base}?${q}`, {
    signal,
    headers: STAY22.apiKey ? { "X-API-KEY": STAY22.apiKey } : {},
  });
  if (res.status === 429) throw Object.assign(new Error("rate_limited"), { code: 429 });
  if (!res.ok) throw new Error(`stay22_${res.status}`);
  const json = await res.json();
  const nights = json.meta?.nights || 1;
  return (json.results || []).map((r) => normalizeStay(r, nights));
}

/* ============================================================================
   TRIP DATA — the shape the backend's single LLM call must return.

   traveler { id, name, color, priorities:[{id,label}] }
   activity { id, title, neighborhood, lat, lng, hours, cost, tags:[priorityId],
              verified?:bool, source?:url }     <- verified/source come from Tavily
   ==========================================================================*/

const HOURS_PER_DAY = 8;
const CHECKIN = "2026-09-12";

const DEFAULT_TRIP = {
  destination: "Lisbon",
  currency: "EUR",
  symbol: "\u20AC",
  travelers: [
    { id: "shay", name: "Shay", color: "#C1121F", priorities: [
      { id: "shay-food", label: "Food markets" },
      { id: "shay-music", label: "Live music" },
      { id: "shay-walk", label: "Walkable neighborhoods" }] },
    { id: "marcus", name: "Marcus", color: "#0F7173", priorities: [
      { id: "marcus-history", label: "History" },
      { id: "marcus-arch", label: "Architecture" },
      { id: "marcus-daytrip", label: "Day trips" }] },
    { id: "priya", name: "Priya", color: "#5B4B8A", priorities: [
      { id: "priya-nature", label: "Coast & nature" },
      { id: "priya-slow", label: "Slow mornings" },
      { id: "priya-craft", label: "Crafts & workshops" }] },
    { id: "dee", name: "Dee", color: "#C77800", priorities: [
      { id: "dee-night", label: "Nightlife" },
      { id: "dee-beach", label: "Beaches" },
      { id: "dee-vintage", label: "Vintage shopping" }] },
  ],
  activities: [
    { id: "a1",  title: "Time Out Market lunch crawl", neighborhood: "Cais do Sodr\u00E9", lat: 38.7062, lng: -9.1449, hours: 2.5, cost: 30, tags: ["shay-food"], verified: true },
    { id: "a2",  title: "Mercado de Campo de Ourique", neighborhood: "Campo de Ourique", lat: 38.7166, lng: -9.1656, hours: 2, cost: 22, tags: ["shay-food", "shay-walk"], verified: true },
    { id: "a3",  title: "Fado night in Alfama", neighborhood: "Alfama", lat: 38.7118, lng: -9.1305, hours: 3, cost: 45, tags: ["shay-music"], verified: true },
    { id: "a4",  title: "Alfama stair walk", neighborhood: "Alfama", lat: 38.7125, lng: -9.1290, hours: 3, cost: 0, tags: ["shay-walk", "marcus-arch"] },
    { id: "a5",  title: "Past\u00E9is de Bel\u00E9m and the riverfront", neighborhood: "Bel\u00E9m", lat: 38.6975, lng: -9.2033, hours: 2.5, cost: 12, tags: ["shay-food", "marcus-arch"], verified: true },
    { id: "a6",  title: "Jer\u00F3nimos Monastery", neighborhood: "Bel\u00E9m", lat: 38.6979, lng: -9.2065, hours: 2.5, cost: 18, tags: ["marcus-history", "marcus-arch"], verified: true },
    { id: "a7",  title: "MAAT museum", neighborhood: "Bel\u00E9m", lat: 38.6960, lng: -9.1937, hours: 2, cost: 11, tags: ["marcus-arch"] },
    { id: "a8",  title: "Castelo de S\u00E3o Jorge", neighborhood: "Alfama", lat: 38.7139, lng: -9.1335, hours: 2.5, cost: 15, tags: ["marcus-history"], verified: true },
    { id: "a9",  title: "Sintra: Pena and Regaleira", neighborhood: "Sintra", lat: 38.7876, lng: -9.3904, hours: 8, cost: 60, tags: ["marcus-daytrip", "marcus-history", "priya-nature"], verified: true },
    { id: "a10", title: "Cabo da Roca and Guincho coast", neighborhood: "Sintra", lat: 38.7803, lng: -9.4989, hours: 6, cost: 35, tags: ["priya-nature", "marcus-daytrip"] },
    { id: "a11", title: "Sunrise at Miradouro da Gra\u00E7a", neighborhood: "Gra\u00E7a", lat: 38.7167, lng: -9.1300, hours: 1.5, cost: 0, tags: ["priya-slow"] },
    { id: "a12", title: "Azulejo tile painting workshop", neighborhood: "Pr\u00EDncipe Real", lat: 38.7168, lng: -9.1495, hours: 3, cost: 55, tags: ["priya-craft"], verified: true },
    { id: "a13", title: "Cork and ceramics studio visit", neighborhood: "Pr\u00EDncipe Real", lat: 38.7175, lng: -9.1512, hours: 2.5, cost: 25, tags: ["priya-craft"] },
    { id: "a14", title: "Botanical garden, no plans", neighborhood: "Pr\u00EDncipe Real", lat: 38.7180, lng: -9.1530, hours: 2, cost: 5, tags: ["priya-slow", "priya-nature"] },
    { id: "a15", title: "Costa da Caparica beach day", neighborhood: "Caparica", lat: 38.6408, lng: -9.2350, hours: 6, cost: 20, tags: ["dee-beach", "priya-nature"], verified: true },
    { id: "a16", title: "Bairro Alto bar crawl", neighborhood: "Bairro Alto", lat: 38.7130, lng: -9.1450, hours: 4, cost: 40, tags: ["dee-night"] },
    { id: "a17", title: "Pink Street, late", neighborhood: "Cais do Sodr\u00E9", lat: 38.7072, lng: -9.1447, hours: 3, cost: 35, tags: ["dee-night", "shay-music"] },
    { id: "a18", title: "Feira da Ladra flea market", neighborhood: "Gra\u00E7a", lat: 38.7152, lng: -9.1268, hours: 2.5, cost: 10, tags: ["dee-vintage", "priya-craft"], verified: true },
    { id: "a19", title: "Pr\u00EDncipe Real vintage shops", neighborhood: "Pr\u00EDncipe Real", lat: 38.7160, lng: -9.1489, hours: 2.5, cost: 30, tags: ["dee-vintage", "shay-walk"] },
    { id: "a20", title: "LX Factory afternoon", neighborhood: "Alc\u00E2ntara", lat: 38.7028, lng: -9.1786, hours: 3, cost: 20, tags: ["dee-vintage", "shay-food"], verified: true },
    { id: "a21", title: "Tram 28, end to end", neighborhood: "Gra\u00E7a", lat: 38.7140, lng: -9.1320, hours: 2, cost: 4, tags: ["shay-walk", "marcus-history"] },
    { id: "a22", title: "Ginjinha and petiscos tasting", neighborhood: "Baixa", lat: 38.7100, lng: -9.1380, hours: 2, cost: 28, tags: ["shay-food"] },
    { id: "a23", title: "Hot Clube de Portugal", neighborhood: "Pr\u00EDncipe Real", lat: 38.7185, lng: -9.1478, hours: 3, cost: 25, tags: ["shay-music", "dee-night"] },
    { id: "a24", title: "Arr\u00E1bida and the Set\u00FAbal coast", neighborhood: "Set\u00FAbal", lat: 38.5244, lng: -8.8882, hours: 8, cost: 70, tags: ["priya-nature", "marcus-daytrip"] },
  ],
};

// Shaped exactly like normalizeStay output so the UI cannot tell the difference.
// Keeps the demo alive through a 429 or dead venue wifi.
const FALLBACK_STAYS = [
  { id: "f1", name: "Casa Amarela Alfama", lat: 38.7115, lng: -9.1302, address: "Alfama, Lisbon", rating: 9.1, stars: null, reviews: 412, guests: 4, bedrooms: 2, freeCancellation: true, thumbnail: null, url: null,
    suppliers: [{ name: "booking", total: 1608, perNight: 179, link: null }, { name: "expedia", total: 1710, perNight: 190, link: null }] },
  { id: "f2", name: "Hotel Pr\u00EDncipe Real", lat: 38.7170, lng: -9.1498, address: "Pr\u00EDncipe Real, Lisbon", rating: 9.4, stars: 4, reviews: 1204, guests: 4, bedrooms: 2, freeCancellation: false, thumbnail: null, url: null,
    suppliers: [{ name: "expedia", total: 1944, perNight: 216, link: null }, { name: "hotelscom", total: 1944, perNight: 216, link: null }, { name: "booking", total: 2160, perNight: 240, link: null }] },
  { id: "f3", name: "Baixa Loft 4B", lat: 38.7104, lng: -9.1381, address: "Baixa, Lisbon", rating: 8.7, stars: null, reviews: 288, guests: 4, bedrooms: 2, freeCancellation: true, thumbnail: null, url: null,
    suppliers: [{ name: "vrbo", total: 1392, perNight: 155, link: null }, { name: "booking", total: 1485, perNight: 165, link: null }] },
  { id: "f4", name: "Sodr\u00E9 Rooms", lat: 38.7066, lng: -9.1451, address: "Cais do Sodr\u00E9, Lisbon", rating: 8.2, stars: 2, reviews: 967, guests: 4, bedrooms: 1, freeCancellation: true, thumbnail: null, url: null,
    suppliers: [{ name: "booking", total: 912, perNight: 101, link: null }] },
  { id: "f5", name: "Quinta Bel\u00E9m Guesthouse", lat: 38.6981, lng: -9.2041, address: "Bel\u00E9m, Lisbon", rating: 8.9, stars: 3, reviews: 533, guests: 4, bedrooms: 2, freeCancellation: false, thumbnail: null, url: null,
    suppliers: [{ name: "hotelscom", total: 1656, perNight: 184, link: null }, { name: "booking", total: 1800, perNight: 200, link: null }] },
  { id: "f6", name: "Gra\u00E7a Miradouro Flat", lat: 38.7165, lng: -9.1298, address: "Gra\u00E7a, Lisbon", rating: 9.6, stars: null, reviews: 176, guests: 4, bedrooms: 2, freeCancellation: true, thumbnail: null, url: null,
    suppliers: [{ name: "vrbo", total: 1476, perNight: 164, link: null }, { name: "expedia", total: 1620, perNight: 180, link: null }] },
].map((s) => {
  const sup = s.suppliers.slice().sort((a, b) => a.total - b.total);
  return { ...s, suppliers: sup, best: sup[0], spread: sup[sup.length - 1].total - sup[0].total, source: "fallback" };
});

/* ============================================================================
   GEO + PLANNING
   ==========================================================================*/

function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The itinerary defines the search viewport. Compress the trip, the box moves.
// Day trips are excluded so one trip to Sintra doesn't drag the box 30km west.
function bboxFor(chosen) {
  const core = chosen.filter((a) => a.hours < 6);
  const pts = core.length ? core : chosen;
  if (!pts.length) return null;
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const pad = 0.012;
  return {
    nelat: (Math.max(...lats) + pad).toFixed(4),
    nelng: (Math.max(...lngs) + pad).toFixed(4),
    swlat: (Math.min(...lats) - pad).toFixed(4),
    swlng: (Math.min(...lngs) - pad).toFixed(4),
  };
}

// Median walk from a stay to the day-to-day stops. Real distance, not vibes.
function walkProfile(stay, chosen) {
  const core = chosen.filter((a) => a.hours < 6);
  if (!core.length || stay.lat == null) return { median: null, within1km: 0 };
  const ds = core.map((a) => haversineKm(stay, a)).sort((x, y) => x - y);
  const median = ds[Math.floor(ds.length / 2)];
  const hoursNear = core.filter((a) => haversineKm(stay, a) <= 1.2).reduce((s, a) => s + a.hours, 0);
  const totalHours = core.reduce((s, a) => s + a.hours, 0) || 1;
  return { median, within1km: Math.round((hoursNear / totalHours) * 100) };
}

const prioIds = (t) => t.priorities.map((p) => p.id);

function coverageFor(traveler, chosen) {
  const ids = prioIds(traveler);
  const covered = new Set();
  chosen.forEach((a) => a.tags.forEach((tag) => { if (ids.includes(tag)) covered.add(tag); }));
  return covered;
}

function tally(votes, id, travelers) {
  const v = votes[id] || {};
  return {
    v,
    inCount: travelers.filter((t) => v[t.id] === "in").length,
    outCount: travelers.filter((t) => v[t.id] === "out").length,
  };
}

function packTrip({ activities, travelers, days, locks, votes, mode }) {
  const budget = days * HOURS_PER_DAY;
  const reasons = {};
  const chosen = [];
  let used = 0;
  const take = (a) => { chosen.push(a); used += a.hours; };

  // Tier 0 — a majority against removes it from the pool.
  const live = [];
  activities.forEach((a) => {
    const { inCount, outCount, v } = tally(votes, a.id, travelers);
    if (outCount > inCount && outCount >= Math.ceil(travelers.length / 2)) {
      reasons[a.id] = "Voted out by " + travelers.filter((t) => v[t.id] === "out").map((t) => t.name).join(" and ");
    } else live.push(a);
  });

  // Tier 1 — manual locks are absolute.
  live.filter((a) => locks.has(a.id)).forEach(take);

  // Tier 2 — anything someone actively wants.
  const rest = live.filter((a) => !locks.has(a.id));
  const placed = new Set(chosen.map((a) => a.id));
  rest
    .map((a) => ({ a, ...tally(votes, a.id, travelers) }))
    .filter((x) => x.inCount > 0)
    .sort((x, y) => y.inCount - x.inCount || x.a.hours - y.a.hours)
    .forEach(({ a, inCount }) => {
      if (used + a.hours <= budget) { take(a); placed.add(a.id); }
      else reasons[a.id] = inCount + " want it, no room at " + days + " days";
    });

  // Tier 3 — fill the rest.
  const pool = rest.filter((a) => !placed.has(a.id) && !reasons[a.id]);
  const density = (a) => a.tags.length / a.hours;

  if (mode === "majority") {
    pool.sort((x, y) => density(y) - density(x)).forEach((a) => {
      if (used + a.hours <= budget) take(a);
      else reasons[a.id] = "No room at " + days + " days";
    });
  } else {
    let progress = true;
    while (progress) {
      progress = false;
      const behind = travelers.slice().sort((t1, t2) =>
        coverageFor(t1, chosen).size / t1.priorities.length -
        coverageFor(t2, chosen).size / t2.priorities.length);
      for (const t of behind) {
        const covered = coverageFor(t, chosen);
        const gaps = prioIds(t).filter((p) => !covered.has(p));
        if (!gaps.length) continue;
        const pick = pool
          .filter((a) => a.tags.some((tag) => gaps.includes(tag)))
          .sort((x, y) => density(y) - density(x))
          .find((a) => used + a.hours <= budget);
        if (pick) { take(pick); pool.splice(pool.indexOf(pick), 1); progress = true; break; }
      }
    }
    pool.slice().sort((x, y) => density(y) - density(x)).forEach((a) => {
      if (used + a.hours <= budget) { take(a); pool.splice(pool.indexOf(a), 1); }
    });
    pool.forEach((a) => { reasons[a.id] = "No room at " + days + " days"; });
  }

  // Days stay inside one neighborhood where they fit.
  const dayList = Array.from({ length: days }, () => []);
  const dayHours = Array(days).fill(0);
  const byHood = {};
  chosen.forEach((a) => { (byHood[a.neighborhood] = byHood[a.neighborhood] || []).push(a); });
  Object.values(byHood).sort((a, b) => b.length - a.length).flat().forEach((a) => {
    let target = -1;
    for (let i = 0; i < days; i++)
      if (dayHours[i] + a.hours <= HOURS_PER_DAY && dayList[i].some((x) => x.neighborhood === a.neighborhood)) { target = i; break; }
    if (target === -1)
      for (let i = 0; i < days; i++) if (dayHours[i] + a.hours <= HOURS_PER_DAY) { target = i; break; }
    if (target === -1) target = dayHours.indexOf(Math.min.apply(null, dayHours));
    dayList[target].push(a);
    dayHours[target] += a.hours;
  });

  const ids = new Set(chosen.map((a) => a.id));
  return {
    dayList, dayHours, chosen, reasons,
    cut: activities.filter((a) => !ids.has(a.id)),
    perPersonActivityCost: chosen.reduce((s, a) => s + a.cost, 0),
  };
}

/* ============================================================================
   STAYS HOOK — debounced, cached, rate-limit aware, never leaves the UI empty.
   Demo mode is 5 req/min. The slider must not fire on every tick.
   ==========================================================================*/

function useStays({ chosen, nights, adults, currency, live }) {
  const [state, setState] = useState({ stays: FALLBACK_STAYS, status: "fallback", error: null });
  const cache = useRef(new Map());
  const abort = useRef(null);
  const bbox = useMemo(() => bboxFor(chosen), [chosen]);

  const checkout = useMemo(() => {
    const d = new Date(CHECKIN + "T00:00:00");
    d.setDate(d.getDate() + nights);
    return d.toISOString().slice(0, 10);
  }, [nights]);

  useEffect(() => {
    if (!live || !bbox) return;
    const key = JSON.stringify([bbox, checkout, adults]);
    if (cache.current.has(key)) {
      setState({ stays: cache.current.get(key), status: "live", error: null });
      return;
    }
    const timer = setTimeout(async () => {
      if (abort.current) abort.current.abort();
      abort.current = new AbortController();
      setState((s) => ({ ...s, status: "loading" }));
      try {
        const stays = await searchStays({
          bbox, checkin: CHECKIN, checkout, adults, currency, signal: abort.current.signal,
        });
        cache.current.set(key, stays);
        setState({ stays, status: "live", error: null });
      } catch (e) {
        if (e.name === "AbortError") return;
        setState({
          stays: FALLBACK_STAYS,
          status: e.code === 429 ? "rate_limited" : "error",
          error: e.message,
        });
      }
    }, 700); // debounce the slider hard, demo mode is 5 req/min
    return () => clearTimeout(timer);
  }, [bbox, checkout, adults, currency, live]);

  return state;
}

/* ============================================================================
   UI
   ==========================================================================*/

const L = "text-[10px] uppercase tracking-[0.16em] font-semibold text-slate-400";
const CARD = "bg-white border border-slate-200 rounded-xl";
const SUPPLIER_LABEL = { booking: "Booking", expedia: "Expedia", hotelscom: "Hotels.com", vrbo: "VRBO" };

export default function GroupTripPlanner({ trip }) {
  // Accept a generated trip; fall back to the hardcoded one when no prop is passed.
  // Every TRIP.* reference below resolves to this local const.
  const TRIP = trip || DEFAULT_TRIP;

  const [days, setDays] = useState(10);
  const [mode, setMode] = useState("everyone");
  const [locks, setLocks] = useState(new Set());
  const [votes, setVotes] = useState({});
  const [stayVotes, setStayVotes] = useState({});
  const [me, setMe] = useState(TRIP.travelers[0]?.id);
  const [tab, setTab] = useState("plan");
  const [chosenStay, setChosenStay] = useState(null);
  const [liveStays, setLiveStays] = useState(false);

  const plan = useMemo(
    () => packTrip({ activities: TRIP.activities, travelers: TRIP.travelers, days, locks, votes, mode }),
    [days, locks, votes, mode]
  );

  const nights = Math.max(days - 1, 1);
  const { stays: rawStays, status } = useStays({
    chosen: plan.chosen, nights, adults: TRIP.travelers.length, currency: TRIP.currency, live: liveStays,
  });

  const stays = useMemo(() => {
    const scored = rawStays.map((s) => {
      const walk = walkProfile(s, plan.chosen);
      const yes = TRIP.travelers.filter((t) => (stayVotes[s.id] || {})[t.id]).length;
      return {
        ...s, ...walk, yes,
        perPerson: s.best ? Math.round(s.best.total / TRIP.travelers.length) : null,
      };
    });
    return scored.sort((a, b) =>
      b.yes - a.yes ||
      b.within1km - a.within1km ||
      (a.best?.total ?? 1e9) - (b.best?.total ?? 1e9));
  }, [rawStays, plan.chosen, stayVotes]);

  const stay = stays.find((s) => s.id === chosenStay) || stays[0];
  const perPersonTotal = plan.perPersonActivityCost + (stay?.perPerson || 0);

  const castVote = useCallback((id, value) => {
    setVotes((prev) => {
      const next = { ...(prev[id] || {}) };
      if (next[me] === value) delete next[me]; else next[me] = value;
      return { ...prev, [id]: next };
    });
  }, [me]);

  const toggleLock = (id) => setLocks((p) => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const ownerOf = (tag) => TRIP.travelers.find((t) => prioIds(t).includes(tag));
  const ownersOf = (a) => Array.from(new Set(a.tags.map(ownerOf).filter(Boolean)));
  const meObj = TRIP.travelers.find((t) => t.id === me);

  const satisfaction = TRIP.travelers.map((t) => {
    const covered = coverageFor(t, plan.chosen);
    return { t, covered, pct: covered.size / t.priorities.length };
  });
  const weakest = satisfaction.reduce((a, b) => (b.pct < a.pct ? b : a), satisfaction[0]);

  /* --- ElevenLabs: speak the change, don't make them read it -------------- */
  const diffLine = useMemo(() => {
    const losing = satisfaction.filter((s) => s.pct < 1).map((s) => s.t.name);
    const head = `${days} days. ${plan.chosen.length} stops, ${plan.cut.length} cut.`;
    const who = losing.length
      ? ` ${losing.join(" and ")} ${losing.length > 1 ? "lose" : "loses"} a priority.`
      : " Everyone still gets all three priorities.";
    const bed = stay ? ` Best stay is ${stay.name}, ${TRIP.symbol}${stay.perPerson} each.` : "";
    return head + who + bed;
  }, [days, plan, satisfaction, stay]);

  const speak = async () => {
    // POST /v1/text-to-speech/{voiceId} from your backend, then play the blob.
    // Keeping the key server-side. Browser fallback below so the demo never dies.
    try {
      const r = await fetch("/api/speak", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: diffLine }),
      });
      if (!r.ok) throw new Error();
      new Audio(URL.createObjectURL(await r.blob())).play();
    } catch {
      if (window.speechSynthesis) window.speechSynthesis.speak(new SpeechSynthesisUtterance(diffLine));
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans antialiased">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="mr-auto">
            <div className={L}>Group trip</div>
            <h1 className="text-2xl font-bold tracking-tight leading-none mt-1">
              {TRIP.destination}
              <span className="text-slate-300 font-normal"> / {TRIP.travelers.length} travelers</span>
            </h1>
          </div>

          <div className="w-64">
            <div className="flex items-baseline justify-between mb-1.5">
              <span className={L}>Length</span>
              <span className="text-sm font-semibold tabular-nums">{days} days · {nights} nights</span>
            </div>
            <input type="range" min="3" max="10" value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-full accent-slate-900 cursor-pointer" aria-label="Trip length in days" />
          </div>

          <div>
            <div className={L + " mb-1.5"}>Plan for</div>
            <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden text-sm font-medium">
              {["everyone", "majority"].map((m) => (
                <button key={m} onClick={() => setMode(m)}
                  className={"px-3 py-1.5 capitalize transition " + (mode === m ? "bg-slate-900 text-white" : "hover:bg-slate-50")}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className={L + " mb-1.5"}>Voting as</div>
            <div className="flex gap-1 items-center">
              {TRIP.travelers.map((t) => (
                <button key={t.id} onClick={() => setMe(t.id)} title={t.name}
                  className={"w-9 h-9 rounded-full text-xs font-bold text-white transition ring-offset-2 " + (me === t.id ? "ring-2 ring-slate-900" : "opacity-40 hover:opacity-80")}
                  style={{ backgroundColor: t.color }}>{t.name[0]}</button>
              ))}
              <button onClick={speak} title="Hear the change"
                className="ml-2 w-9 h-9 rounded-full border border-slate-300 flex items-center justify-center hover:bg-slate-50 transition">
                <Volume2 size={15} className="text-slate-500" />
              </button>
            </div>
          </div>
        </div>

        <div className="max-w-[1400px] mx-auto px-6 flex gap-6 border-t border-slate-100">
          {[["plan", "Itinerary"], ["vote", "Vote (" + TRIP.activities.length + ")"], ["stays", "Stays"]].map(([k, lbl]) => (
            <button key={k} onClick={() => setTab(k)}
              className={"py-2.5 text-sm font-medium border-b-2 -mb-px transition " + (tab === k ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400 hover:text-slate-700")}>
              {lbl}
            </button>
          ))}
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[264px_1fr] gap-6 items-start">
        <aside className="space-y-4 lg:sticky lg:top-32">
          <section className={CARD + " p-4"}>
            <div className="flex items-center gap-1.5 mb-3">
              <Users size={13} className="text-slate-400" /><span className={L}>Priorities met</span>
            </div>
            <div className="space-y-3.5">
              {satisfaction.map(({ t, covered }) => (
                <div key={t.id}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-sm font-semibold">{t.name}</span>
                    <span className="text-xs font-bold tabular-nums"
                      style={{ color: covered.size < t.priorities.length ? "#94a3b8" : t.color }}>
                      {covered.size}/{t.priorities.length}
                    </span>
                  </div>
                  <div className="flex gap-1 mb-1.5">
                    {t.priorities.map((p) => (
                      <div key={p.id} className="h-1.5 flex-1 rounded-full transition-colors duration-500"
                        style={{ backgroundColor: covered.has(p.id) ? t.color : "#e2e8f0" }} />
                    ))}
                  </div>
                  {t.priorities.map((p) => (
                    <div key={p.id} className={"text-[11px] leading-relaxed " + (covered.has(p.id) ? "text-slate-500" : "text-slate-300 line-through")}>
                      {p.label}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {weakest && weakest.pct < 1 && (
              <div className="mt-4 pt-3 border-t border-slate-100 flex gap-2 text-[11px] text-slate-500 leading-relaxed">
                <AlertCircle size={13} className="shrink-0 mt-px text-amber-500" />
                <span>{weakest.t.name} is losing the most at {days} days.
                  {mode === "majority" && " Switch to Everyone to protect them."}</span>
              </div>
            )}
          </section>

          <section className={CARD + " p-4"}>
            <div className="flex items-center gap-1.5 mb-3">
              <Wallet size={13} className="text-slate-400" /><span className={L}>Per person</span>
            </div>
            <div className="space-y-1.5 text-sm">
              <Row k="Activities" v={TRIP.symbol + plan.perPersonActivityCost} />
              <Row k={"Stay · " + nights + "n"} v={stay?.perPerson ? TRIP.symbol + stay.perPerson : "—"} />
              <div className="pt-1.5 border-t border-slate-100 flex justify-between font-bold">
                <span>Total</span><span className="tabular-nums">{TRIP.symbol}{perPersonTotal}</span>
              </div>
            </div>
          </section>

          <section className={CARD + " p-4"}>
            <div className="flex items-center gap-1.5 mb-3">
              <Scissors size={13} className="text-slate-400" /><span className={L}>Cut ({plan.cut.length})</span>
            </div>
            {plan.cut.length === 0 ? <p className="text-[11px] text-slate-400">Everything fits.</p> : (
              <ul className="space-y-2">
                {plan.cut.map((a) => (
                  <li key={a.id} className="text-[11px] flex gap-1.5">
                    <div className="flex gap-0.5 mt-1.5 shrink-0">
                      {ownersOf(a).map((o) => <span key={o.id} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: o.color }} />)}
                    </div>
                    <div>
                      <div className="text-slate-600">{a.title}</div>
                      <div className="text-slate-400">{plan.reasons[a.id]}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <main>
          {tab === "plan" && (
            <>
              <div className="flex items-center gap-1.5 mb-3">
                <Calendar size={13} className="text-slate-400" />
                <span className={L}>Click a stop to lock it. Locked stops survive any change.</span>
              </div>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
                {plan.dayList.map((items, i) => (
                  <div key={i} className={CARD + " p-3"}>
                    <div className="flex items-baseline justify-between pb-2 mb-2.5 border-b border-slate-100">
                      <span className="text-xs font-bold">Day {i + 1}</span>
                      <span className={"text-[10px] tabular-nums " + (plan.dayHours[i] > HOURS_PER_DAY ? "text-amber-600 font-semibold" : "text-slate-400")}>
                        {plan.dayHours[i]}h
                      </span>
                    </div>
                    <div className="space-y-2">
                      {items.length === 0 && <p className="text-[11px] text-slate-300">Open day.</p>}
                      {items.map((a) => {
                        const { inCount, outCount } = tally(votes, a.id, TRIP.travelers);
                        const isLocked = locks.has(a.id);
                        return (
                          <button key={a.id} onClick={() => toggleLock(a.id)}
                            className={"w-full text-left rounded-lg p-2 border transition " + (isLocked ? "bg-slate-900 text-white border-slate-900" : "bg-slate-50 border-transparent hover:border-slate-300")}>
                            <div className="flex justify-between gap-1.5">
                              <span className="text-[11.5px] font-semibold leading-snug">{a.title}</span>
                              {isLocked ? <Lock size={11} className="shrink-0 mt-0.5" />
                                : a.verified && <BadgeCheck size={11} className="shrink-0 mt-0.5 text-emerald-500" />}
                            </div>
                            <div className="flex items-center gap-1.5 mt-1.5">
                              <div className="flex gap-0.5">
                                {ownersOf(a).map((o) => <span key={o.id} title={o.name} className="w-2 h-2 rounded-full ring-1 ring-white" style={{ backgroundColor: o.color }} />)}
                              </div>
                              <span className="text-[10px] text-slate-400">{a.neighborhood} · {a.hours}h</span>
                              {inCount > 0 && <span className="ml-auto text-[10px] font-bold text-emerald-500">+{inCount}</span>}
                              {outCount > 0 && <span className="text-[10px] font-bold text-rose-400">−{outCount}</span>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "vote" && (
            <>
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className={L}>Voting as</span>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: meObj.color }}>{meObj.name}</span>
                <span className="text-[11px] text-slate-400">Want it and it gets protected. Skip it and a majority removes it.</span>
              </div>
              <div className={CARD + " divide-y divide-slate-100"}>
                {TRIP.activities.map((a) => {
                  const { inCount, outCount, v } = tally(votes, a.id, TRIP.travelers);
                  const inPlan = plan.chosen.some((c) => c.id === a.id);
                  const myVote = v[me];
                  return (
                    <div key={a.id} className="p-3 flex items-center gap-3 hover:bg-slate-50/60 transition">
                      <div className="flex gap-0.5 w-8 shrink-0">
                        {ownersOf(a).map((o) => <span key={o.id} title={o.name} className="w-2 h-2 rounded-full" style={{ backgroundColor: o.color }} />)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={"text-sm font-semibold truncate flex items-center gap-1 " + (inPlan ? "" : "text-slate-400")}>
                          {a.title}
                          {a.verified && <BadgeCheck size={12} className="text-emerald-500 shrink-0" />}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {a.neighborhood} · {a.hours}h · {TRIP.symbol}{a.cost}
                          {!inPlan && <span className="text-rose-400"> · not in plan</span>}
                        </div>
                      </div>
                      <div className="hidden sm:flex gap-0.5 w-20 shrink-0">
                        {TRIP.travelers.map((t) => (
                          <span key={t.id} title={t.name + ": " + (v[t.id] || "no vote")} className="h-5 flex-1 rounded-sm"
                            style={{ backgroundColor: v[t.id] === "in" ? t.color : v[t.id] === "out" ? "#fecdd3" : "#f1f5f9" }} />
                        ))}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <VoteBtn active={myVote === "in"} onClick={() => castVote(a.id, "in")} tone="in" icon={<Check size={13} />} label="Want" />
                        <VoteBtn active={myVote === "out"} onClick={() => castVote(a.id, "out")} tone="out" icon={<X size={13} />} label="Skip" />
                      </div>
                      <div className="w-12 text-right text-xs tabular-nums font-bold shrink-0">
                        {inCount > 0 && <span className="text-emerald-600">+{inCount}</span>}
                        {outCount > 0 && <span className="text-rose-500 ml-1">−{outCount}</span>}
                        {inCount + outCount === 0 && <Minus size={12} className="inline text-slate-300" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {tab === "stays" && (
            <>
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <Bed size={13} className="text-slate-400" />
                <span className={L}>{nights} nights · {TRIP.travelers.length} guests · searched inside your plan's map area</span>
                <StatusPill status={status} />
                <button onClick={() => setLiveStays((v) => !v)}
                  className={"ml-auto text-[11px] font-semibold px-2.5 py-1 rounded-lg border transition flex items-center gap-1 " + (liveStays ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 hover:bg-slate-50")}>
                  <RefreshCw size={11} />{liveStays ? "Live prices on" : "Go live"}
                </button>
              </div>

              {stays[0]?.yes >= 2 && (
                <div className="text-xs font-semibold text-slate-700 mb-2.5">
                  {stays[0].yes} of {TRIP.travelers.length} want {stays[0].name}
                </div>
              )}

              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
                {stays.map((s) => {
                  const sv = stayVotes[s.id] || {};
                  const selected = (chosenStay || stays[0]?.id) === s.id;
                  return (
                    <div key={s.id} className={CARD + " p-4 " + (selected ? "ring-2 ring-slate-900" : "")}>
                      <div className="flex justify-between items-start gap-3">
                        <div className="min-w-0">
                          <div className="font-bold text-sm leading-tight">{s.name}</div>
                          <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1 flex-wrap">
                            <MapPin size={10} />
                            {s.median != null ? `${s.median.toFixed(1)} km median walk` : "distance unknown"}
                            {s.rating != null && (
                              <>
                                <Star size={10} className="ml-1 fill-amber-400 text-amber-400" />
                                {s.rating}<span className="text-slate-300">/10 ({s.reviews})</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-lg font-bold tabular-nums leading-none">{TRIP.symbol}{s.perPerson}</div>
                          <div className="text-[10px] text-slate-400">each · {nights}n</div>
                        </div>
                      </div>

                      <div className="mt-3">
                        <div className="flex justify-between text-[10px] font-semibold mb-1">
                          <span className="text-slate-400 uppercase tracking-wider">Plan within a 15 min walk</span>
                          <span className="tabular-nums">{s.within1km}%</span>
                        </div>
                        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-slate-900 rounded-full transition-all duration-500" style={{ width: s.within1km + "%" }} />
                        </div>
                      </div>

                      {/* The Stay22 field nobody else will show */}
                      <div className="mt-3 rounded-lg bg-slate-50 p-2">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                            {s.suppliers.length} {s.suppliers.length === 1 ? "supplier" : "suppliers"}
                          </span>
                          {s.spread > 0 && (
                            <span className="text-[10px] font-bold text-emerald-600">
                              Save {TRIP.symbol}{s.spread} booking the cheapest
                            </span>
                          )}
                        </div>
                        <div className="space-y-1">
                          {s.suppliers.map((sup, i) => (
                            <a key={sup.name} href={sup.link || s.url || undefined}
                              target="_blank" rel="noopener noreferrer"
                              className={"flex items-center justify-between text-[11px] px-1.5 py-1 rounded transition " + (i === 0 ? "bg-white font-semibold" : "text-slate-400 hover:text-slate-700")}>
                              <span>{SUPPLIER_LABEL[sup.name] || sup.name}{i === 0 && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-emerald-600">cheapest</span>}</span>
                              <span className="tabular-nums">{TRIP.symbol}{sup.total}<span className="text-slate-300 ml-1">· {TRIP.symbol}{sup.perNight}/n</span></span>
                            </a>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100">
                        <div className="flex gap-1 mr-auto items-center">
                          {TRIP.travelers.map((t) => (
                            <button key={t.id} disabled={t.id !== me}
                              onClick={() => setStayVotes((p) => ({ ...p, [s.id]: { ...(p[s.id] || {}), [t.id]: !(p[s.id] || {})[t.id] } }))}
                              title={t.id === me ? "Your vote" : t.name + "'s vote"}
                              className={"w-6 h-6 rounded-full text-[10px] font-bold text-white transition " + (sv[t.id] ? "" : "opacity-25") + (t.id === me ? " hover:opacity-100" : " cursor-default")}
                              style={{ backgroundColor: t.color }}>{t.name[0]}</button>
                          ))}
                          <span className="text-[11px] text-slate-400 ml-1">{s.yes}/{TRIP.travelers.length}</span>
                        </div>
                        <button onClick={() => setChosenStay(s.id)}
                          className={"text-xs font-semibold px-3 py-1.5 rounded-lg transition flex items-center gap-1 " + (selected ? "bg-slate-900 text-white" : "bg-slate-100 hover:bg-slate-200")}>
                          {selected ? "Chosen" : "Choose"} <ChevronRight size={12} />
                        </button>
                      </div>
                      {s.freeCancellation && (
                        <div className="text-[10px] text-emerald-600 mt-2">Free cancellation</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    live: ["Live prices", "bg-emerald-50 text-emerald-700"],
    loading: ["Fetching", "bg-slate-100 text-slate-500"],
    fallback: ["Sample data", "bg-slate-100 text-slate-500"],
    rate_limited: ["Rate limited, showing last known", "bg-amber-50 text-amber-700"],
    error: ["Offline, showing sample", "bg-amber-50 text-amber-700"],
  };
  const [text, cls] = map[status] || map.fallback;
  return (
    <span className={"text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 " + cls}>
      {status === "loading" && <Loader2 size={9} className="animate-spin" />}{text}
    </span>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between text-slate-500">
      <span>{k}</span><span className="tabular-nums text-slate-900 font-medium">{v}</span>
    </div>
  );
}

function VoteBtn({ active, onClick, tone, icon, label }) {
  const on = tone === "in" ? "bg-emerald-600 text-white border-emerald-600" : "bg-rose-500 text-white border-rose-500";
  return (
    <button onClick={onClick} aria-pressed={active} title={label}
      className={"w-7 h-7 rounded-lg border flex items-center justify-center transition " + (active ? on : "bg-white text-slate-400 border-slate-200 hover:border-slate-400")}>
      {icon}
    </button>
  );
}
