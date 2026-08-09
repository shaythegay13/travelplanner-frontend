// POST /api/trip
// Body: { destination: string, travelers: [{ name, priorities: [string] }] }
// Returns the exact TRIP shape at the top of GroupTripPlanner.jsx.
//
// Design note: traveler ids, priority ids, and colors are assigned HERE, in code —
// not by the model. `tags` must contain priority *ids*, and that join key is what
// the entire planning engine runs on. Handing the model a fixed list of ids to
// reference is far more reliable than asking it to invent and stay consistent with
// its own. The single LLM call therefore only produces currency, symbol, and the
// activity pool.

import Anthropic from "@anthropic-ai/sdk";

// Vercel: this call can take a while at 20-30 activities. Give it room.
export const maxDuration = 60;

const PALETTE = [
  "#C1121F",
  "#0F7173",
  "#5B4B8A",
  "#C77800",
  "#2563A8",
  "#8A5A2B",
];

const MAX_TRAVELERS = 6;

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);

// Stable, collision-free ids derived from the traveler names / priority labels.
function buildTravelers(rawTravelers) {
  const usedTravelerIds = new Set();

  return rawTravelers.slice(0, MAX_TRAVELERS).map((t, i) => {
    let base = slug(t.name) || `traveler-${i + 1}`;
    let id = base;
    let n = 2;
    while (usedTravelerIds.has(id)) id = `${base}-${n++}`;
    usedTravelerIds.add(id);

    const usedPriorityIds = new Set();
    const priorities = (t.priorities || [])
      .map((label) => String(label).trim())
      .filter(Boolean)
      .map((label, j) => {
        let pBase = `${id}-${slug(label) || `p${j + 1}`}`;
        let pid = pBase;
        let m = 2;
        while (usedPriorityIds.has(pid)) pid = `${pBase}-${m++}`;
        usedPriorityIds.add(pid);
        return { id: pid, label };
      });

    return { id, name: String(t.name).trim(), color: PALETTE[i % PALETTE.length], priorities };
  });
}

// The model returns only this much. Everything else we already know.
const ACTIVITY_SCHEMA = {
  type: "object",
  properties: {
    currency: {
      type: "string",
      description: "ISO 4217 code for the destination, e.g. EUR, JPY, USD",
    },
    symbol: {
      type: "string",
      description: "Currency symbol, e.g. €, ¥, $",
    },
    activities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short unique id like a1, a2, a3" },
          title: { type: "string" },
          neighborhood: { type: "string" },
          lat: { type: "number" },
          lng: { type: "number" },
          hours: { type: "number", description: "Duration in hours, e.g. 2.5" },
          cost: {
            type: "number",
            description: "Per person in local currency, 0 if free",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Priority IDs from the provided list. Never labels.",
          },
        },
        required: [
          "id",
          "title",
          "neighborhood",
          "lat",
          "lng",
          "hours",
          "cost",
          "tags",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["currency", "symbol", "activities"],
  additionalProperties: false,
};

function buildPrompt(destination, travelers) {
  const roster = travelers
    .map(
      (t) =>
        `${t.name}:\n` +
        t.priorities.map((p) => `  - id "${p.id}" = ${p.label}`).join("\n")
    )
    .join("\n");

  const allIds = travelers.flatMap((t) => t.priorities.map((p) => p.id));

  return `Build an activity pool for a group trip to ${destination}.

Travelers and their priorities (use these exact priority IDs):
${roster}

Rules:
- Produce 20-30 activities. More than any trip length can hold — the planner cuts down.
- Every priority ID above must be covered by at least 2 activities.
- Include 2-3 full-day options with hours >= 6 (day trips, coastal runs, etc).
- Every activity needs real, accurate lat/lng for a genuine place in or near ${destination}.
- cost is per person in the local currency; use 0 for free.
- tags must contain ONLY these priority IDs: ${allIds.join(", ")}
  Never use labels, never invent an ID.
- An activity may carry multiple tags when it genuinely serves several priorities.
- Vary neighborhoods so the planner can cluster days geographically.
- Give real, specific venue and place names, not generic descriptions.`;
}

// Belt and braces: strip markdown fences even though structured outputs shouldn't emit them.
function parseModelJson(text) {
  let s = String(text).trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first > 0 || last < s.length - 1) {
    if (first !== -1 && last !== -1) s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

export async function POST(request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 501 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const destination = String(body?.destination || "").trim();
  const rawTravelers = Array.isArray(body?.travelers) ? body.travelers : [];

  if (!destination) {
    return Response.json({ error: "destination is required" }, { status: 400 });
  }
  const usable = rawTravelers.filter(
    (t) => t && String(t.name || "").trim() && (t.priorities || []).length
  );
  if (!usable.length) {
    return Response.json(
      { error: "At least one traveler with a name and priorities is required" },
      { status: 400 }
    );
  }

  const travelers = buildTravelers(usable);
  const validIds = new Set(travelers.flatMap((t) => t.priorities.map((p) => p.id)));

  const client = new Anthropic();

  let parsed;
  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: ACTIVITY_SCHEMA },
      },
      system:
        "You are a travel planner building the raw activity pool a group-trip " +
        "planning engine will select from. Accuracy of coordinates and correct " +
        "use of the supplied priority IDs matter more than prose.",
      messages: [{ role: "user", content: buildPrompt(destination, travelers) }],
    });

    if (response.stop_reason === "refusal") {
      return Response.json(
        { error: "The model declined this request." },
        { status: 502 }
      );
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    parsed = parseModelJson(text);
  } catch (err) {
    return Response.json(
      { error: `Trip generation failed: ${err?.message || "unknown error"}` },
      { status: 502 }
    );
  }

  // Validate hard: the planning engine assumes lat/lng exist and tags join.
  const seenIds = new Set();
  const activities = (parsed.activities || [])
    .map((a, i) => {
      const tags = (a.tags || []).filter((t) => validIds.has(t));
      const lat = Number(a.lat);
      const lng = Number(a.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (!tags.length) return null; // untagged activities are invisible to the engine

      let id = String(a.id || `a${i + 1}`);
      while (seenIds.has(id)) id = `${id}x`;
      seenIds.add(id);

      return {
        id,
        title: String(a.title || "Untitled"),
        neighborhood: String(a.neighborhood || destination),
        lat,
        lng,
        hours: Math.max(0.5, Number(a.hours) || 2),
        cost: Math.max(0, Number(a.cost) || 0),
        tags,
      };
    })
    .filter(Boolean);

  if (!activities.length) {
    return Response.json(
      { error: "Model returned no usable activities. Try again." },
      { status: 502 }
    );
  }

  return Response.json({
    destination,
    currency: String(parsed.currency || "USD"),
    symbol: String(parsed.symbol || "$"),
    travelers,
    activities,
  });
}
