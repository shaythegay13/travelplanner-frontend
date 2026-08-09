# Group trip planner — frontend

A group trip planner that compresses an itinerary to any trip length while keeping
track of whose priorities get dropped. Built from `CLAUDE-CODE-BRIEF.md`.

## Run it

```bash
npm install
cp .env.example .env.local   # add your keys
npm run dev
```

Open http://localhost:3000. The app opens on a setup screen; there's also a
"Use the Lisbon sample" button that skips the API call and renders the
hardcoded trip, which is handy on stage if a key is missing.

## Layout

```
src/
  app/
    page.js                 setup screen -> planner, all state in memory
    layout.js
    globals.css
    api/
      trip/route.js         POST — one Claude call, returns the TRIP shape
      speak/route.js        POST — ElevenLabs TTS, streams back audio/mpeg
  components/
    GroupTripPlanner.jsx    the planning engine + UI (source of truth)
    TripSetup.jsx           destination, travelers, priority chips
```

## The join key

`activity.tags` contains priority **ids**, never labels. That is what the entire
planning engine joins on.

`/api/trip` assigns traveler ids, priority ids, and colors **in code** and passes
the id list to the model, which only produces the activity pool. Handing the model
a fixed set of ids to reference is far more reliable than asking it to invent and
stay consistent with its own. The route then drops any activity whose tags don't
resolve or whose lat/lng is missing, because the stay-scoring layer is dead
without coordinates.

## Environment

| Variable | Required | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | for `/api/trip` | route returns 501, setup screen shows the error |
| `ELEVENLABS_API_KEY` | no | route returns 501, component falls back to browser speech |
| `ELEVENLABS_VOICE_ID` | no | uses a stock voice |
| `STAY22_API_KEY` | no | Stay22 runs in demo mode (5 req/min) |

Stay22 is called from the browser and is already wired — no backend needed. For a
key, set `STAY22.apiKey` and `STAY22.aid` at the top of `GroupTripPlanner.jsx`;
`aid` is what earns the commission.

## Deploying

Push to a repo, import into Vercel, set the env vars in project settings. The
`/api/trip` route sets `maxDuration = 60` — generating 20–30 activities takes a
while, and the Vercel default would cut it off.

## Not built, deliberately

Database, auth, real-time sync, maps, drag and drop, flight search, payments,
dark mode, mobile-specific layouts, tests.
