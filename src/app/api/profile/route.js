// POST /api/profile
// Body: { handle: string, name?: string }
//
// `handle` is a public profile the USER supplied about THEMSELVES — an Instagram
// handle, a travel blog, a personal site. Tavily reads that specific source and
// Claude maps what it finds onto the canonical priority chips.
//
// Deliberate constraint: this route will not research a person by name. A name is
// not an identifier — "search the web for Sarah Chen's travel preferences" returns
// a confident profile of the wrong Sarah, and the user has no way to know. `name`
// is accepted only as a disambiguating hint alongside a handle, never as the
// search subject on its own. Everything returned is a *suggestion* the user
// confirms or edits before it is used.

import Anthropic from "@anthropic-ai/sdk";
import { CHIPS, PRIORITIES_PER_TRAVELER } from "@/lib/priorities";

export const maxDuration = 60;

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

// Looks like a bare name ("Shay Bouchles") rather than a handle/URL/site.
function looksLikeBareName(s) {
  const v = s.trim();
  if (/[/@.]/.test(v)) return false; // has a URL, @handle, or domain
  return /^[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,3}$/u.test(v);
}

function normalizeTarget(handle) {
  const v = handle.trim().replace(/^@/, "");
  if (/^https?:\/\//i.test(v)) return { query: v, kind: "url" };
  if (/\.[a-z]{2,}(\/|$)/i.test(v)) return { query: v, kind: "site" };
  return { query: v, kind: "handle" };
}

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "One or two sentences on the travel style evidenced by the sources. If the sources say little, say so plainly.",
    },
    priorities: {
      type: "array",
      items: { type: "string" },
      description:
        "Up to 3 travel priorities, each EXACTLY matching one of the provided chip labels.",
    },
    custom: {
      type: "array",
      items: { type: "string" },
      description:
        "Up to 2 short preference labels (2-4 words) only when nothing in the chip list fits. Empty array is fine.",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description:
        "low when the sources are thin, generic, or may describe a different person.",
    },
  },
  required: ["summary", "priorities", "custom", "confidence"],
  additionalProperties: false,
};

// No-LLM fallback. Used when ANTHROPIC_API_KEY is absent or the model call fails,
// so profile import still does something useful instead of dying. Crude on purpose:
// it only ever *suggests*, and the user confirms before anything is used.
const KEYWORDS = {
  "Food markets": ["market", "food hall", "street market", "produce"],
  "Live music": ["live music", "concert", "gig", "jazz", "band", "venue"],
  "Walkable neighborhoods": ["walkable", "wander", "stroll", "on foot", "neighbourhood", "neighborhood"],
  History: ["history", "historic", "ancient", "ruins", "heritage", "castle"],
  Architecture: ["architecture", "cathedral", "building", "baroque", "gothic"],
  "Day trips": ["day trip", "excursion", "nearby town", "getaway"],
  "Coast & nature": ["coast", "nature", "national park", "cliff", "wildlife", "lake"],
  "Slow mornings": ["slow morning", "sunrise", "lazy", "unhurried", "slow travel"],
  "Crafts & workshops": ["workshop", "craft", "pottery", "ceramic", "artisan"],
  Nightlife: ["nightlife", "bar", "club", "cocktail", "party", "late night"],
  Beaches: ["beach", "surf", "sand", "seaside", "swim"],
  "Vintage shopping": ["vintage", "thrift", "flea market", "antique", "second-hand"],
  Museums: ["museum", "gallery", "exhibition", "curator"],
  "Street food": ["street food", "food stall", "hawker", "taco", "noodle"],
  Hiking: ["hike", "hiking", "trail", "trek", "summit", "backpack"],
  "Coffee shops": ["coffee", "cafe", "café", "espresso", "roaster"],
  "Parks & gardens": ["park", "garden", "botanical", "green space"],
  Photography: ["photo", "photography", "camera", "shot", "lens"],
};

function heuristicPriorities(text, limit) {
  const hay = text.toLowerCase();
  return Object.entries(KEYWORDS)
    .map(([label, terms]) => ({
      label,
      score: terms.reduce(
        (n, t) => n + (hay.split(t.toLowerCase()).length - 1),
        0
      ),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.label);
}

async function tavilySearch(target, apiKey) {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query:
        target.kind === "url" || target.kind === "site"
          ? `${target.query} travel trips destinations`
          : `"${target.query}" travel trips destinations preferences`,
      search_depth: "basic",
      max_results: 6,
      include_answer: true,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Tavily ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

export async function POST(request) {
  // Validate the request on its own merits first, so a malformed call gets a 400
  // whether or not the environment happens to be configured. This also keeps the
  // name guardrail below testable without live keys.
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const handle = String(body?.handle || "").trim();
  const name = String(body?.name || "").trim();

  if (!handle) {
    return Response.json(
      {
        error:
          "A public profile link or handle is required. Enter your own site, blog, or @handle.",
      },
      { status: 400 }
    );
  }

  // Enforce the design constraint in code, not just in the prompt.
  if (looksLikeBareName(handle)) {
    return Response.json(
      {
        error:
          "That looks like a name. Names match too many people to research reliably — paste a link or @handle to your own public profile instead, or skip this step.",
      },
      { status: 400 }
    );
  }

  const target = normalizeTarget(handle);

  // Tavily is the one hard requirement — without it there is nothing to read.
  // Claude is the mapping step and has a fallback, so it is not required here.
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) {
    return Response.json({ error: "TAVILY_API_KEY not set" }, { status: 501 });
  }

  let search;
  try {
    search = await tavilySearch(target, tavilyKey);
  } catch (err) {
    return Response.json(
      { error: `Profile research failed: ${err?.message || "unknown error"}` },
      { status: 502 }
    );
  }

  const results = (search?.results || []).slice(0, 6);
  const sources = results.map((r) => ({
    title: String(r.title || r.url || "source"),
    url: String(r.url || ""),
  }));

  if (!results.length) {
    return Response.json({
      summary: "Nothing public turned up for that profile.",
      priorities: [],
      custom: [],
      confidence: "low",
      sources: [],
      target: target.query,
    });
  }

  const evidence = results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title || "untitled"} — ${r.url || ""}\n${String(
          r.content || ""
        ).slice(0, 700)}`
    )
    .join("\n\n");

  // Fallback shape, used if the model is unavailable or errors.
  const degraded = () => {
    const corpus = [search?.answer || "", evidence].join("\n");
    return Response.json({
      summary:
        String(search?.answer || "").slice(0, 400) ||
        "Found public pages for that profile.",
      priorities: heuristicPriorities(corpus, PRIORITIES_PER_TRAVELER),
      custom: [],
      confidence: "low",
      sources,
      target: target.query,
      degraded: true, // matched by keyword, not by model
    });
  };

  if (!process.env.ANTHROPIC_API_KEY) return degraded();

  const client = new Anthropic();

  let parsed;
  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 4000,
      output_config: {
        effort: "low", // extraction and mapping, not deep reasoning
        format: { type: "json_schema", schema: PROFILE_SCHEMA },
      },
      system:
        "You map evidence about a traveler's public activity onto a fixed list of " +
        "travel priority labels. Only claim what the sources support. If the sources " +
        "are thin, generic, or might describe a different person, return few or no " +
        "priorities and set confidence to low. Do not speculate to fill the list, and " +
        "do not infer sensitive attributes (health, religion, politics, relationships).",
      messages: [
        {
          role: "user",
          content: `Public profile the user gave for themselves: ${target.query}${
            name ? ` (they go by "${name}")` : ""
          }

Choose priorities EXACTLY from this list:
${CHIPS.map((c) => `- ${c}`).join("\n")}

Return at most ${PRIORITIES_PER_TRAVELER} priorities. Add a "custom" label only when
nothing in the list fits what the sources actually show.

Search results:
${evidence}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") return degraded();

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
  } catch {
    // Tavily already gave us something worth showing — don't throw it away.
    return degraded();
  }

  // Only hand back chip labels we actually recognise.
  const priorities = (parsed.priorities || [])
    .filter((p) => CHIPS.includes(p))
    .slice(0, PRIORITIES_PER_TRAVELER);

  const custom = (parsed.custom || [])
    .map((c) => String(c).trim())
    .filter((c) => c && c.length <= 40 && !CHIPS.includes(c))
    .slice(0, Math.max(0, PRIORITIES_PER_TRAVELER - priorities.length));

  return Response.json({
    summary: String(parsed.summary || ""),
    priorities,
    custom,
    confidence: ["high", "medium", "low"].includes(parsed.confidence)
      ? parsed.confidence
      : "low",
    sources,
    target: target.query,
  });
}
