"use client";

import React, { useState } from "react";
import { Plus, X, Loader2, ArrowRight, AlertCircle } from "lucide-react";

// PALETTE is mirrored server-side in /api/trip so the colors the setup screen
// shows are the colors the planner renders.
import {
  CHIPS,
  PALETTE,
  MAX_TRAVELERS,
  PRIORITIES_PER_TRAVELER,
} from "@/lib/priorities";

const L = "text-[10px] uppercase tracking-[0.16em] font-semibold text-slate-400";
const CARD = "bg-white border border-slate-200 rounded-xl";

const blankTraveler = () => ({ name: "", priorities: [] });

export default function TripSetup({ onReady, onSkip, initialTraveler }) {
  const [destination, setDestination] = useState("");
  // Traveler 1 is prefilled from the account step when there is one.
  const [travelers, setTravelers] = useState(() => [
    initialTraveler?.name
      ? {
          name: initialTraveler.name,
          priorities: (initialTraveler.priorities || []).slice(
            0,
            PRIORITIES_PER_TRAVELER
          ),
        }
      : blankTraveler(),
    blankTraveler(),
  ]);
  const [custom, setCustom] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const setTraveler = (i, patch) =>
    setTravelers((prev) =>
      prev.map((t, j) => (j === i ? { ...t, ...patch } : t))
    );

  const togglePriority = (i, label) =>
    setTravelers((prev) =>
      prev.map((t, j) => {
        if (j !== i) return t;
        const has = t.priorities.includes(label);
        if (has)
          return { ...t, priorities: t.priorities.filter((p) => p !== label) };
        if (t.priorities.length >= PRIORITIES_PER_TRAVELER) return t;
        return { ...t, priorities: [...t.priorities, label] };
      })
    );

  const addCustom = (i) => {
    const label = (custom[i] || "").trim();
    if (!label) return;
    setTravelers((prev) =>
      prev.map((t, j) => {
        if (j !== i) return t;
        if (t.priorities.includes(label)) return t;
        if (t.priorities.length >= PRIORITIES_PER_TRAVELER) return t;
        return { ...t, priorities: [...t.priorities, label] };
      })
    );
    setCustom((c) => ({ ...c, [i]: "" }));
  };

  const ready =
    destination.trim() &&
    travelers.some((t) => t.name.trim() && t.priorities.length > 0) &&
    travelers.every((t) => !t.name.trim() || t.priorities.length > 0);

  const build = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = {
        destination: destination.trim(),
        travelers: travelers
          .filter((t) => t.name.trim() && t.priorities.length)
          .map((t) => ({ name: t.name.trim(), priorities: t.priorities })),
      };
      const res = await fetch("/api/trip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      onReady(data);
    } catch (e) {
      setError(e.message || "Something went wrong.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans antialiased">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-[820px] mx-auto px-6 py-5">
          <div className={L}>Group trip</div>
          <h1 className="text-2xl font-bold tracking-tight leading-none mt-1">
            Plan a trip everyone actually wants
          </h1>
          <p className="text-sm text-slate-500 mt-2 leading-relaxed">
            Tell us where you&apos;re going and what each person cares about. We&apos;ll
            build the activity pool, then the planner compresses it to fit any trip
            length.
          </p>
        </div>
      </header>

      <div className="max-w-[820px] mx-auto px-6 py-6 space-y-4">
        <section className={CARD + " p-4"}>
          <label className={L + " block mb-2"} htmlFor="destination">
            Destination
          </label>
          <input
            id="destination"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="Lisbon"
            disabled={loading}
            className="w-full text-lg font-semibold px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:opacity-50"
          />
        </section>

        {travelers.map((t, i) => {
          const color = PALETTE[i % PALETTE.length];
          const full = t.priorities.length >= PRIORITIES_PER_TRAVELER;
          return (
            <section key={i} className={CARD + " p-4"}>
              <div className="flex items-center gap-3 mb-3">
                <span
                  className="w-9 h-9 rounded-full text-xs font-bold text-white flex items-center justify-center shrink-0"
                  style={{ backgroundColor: color }}
                >
                  {t.name.trim() ? t.name.trim()[0].toUpperCase() : i + 1}
                </span>
                <input
                  value={t.name}
                  onChange={(e) => setTraveler(i, { name: e.target.value })}
                  placeholder={`Traveler ${i + 1}`}
                  disabled={loading}
                  className="flex-1 text-sm font-semibold px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:opacity-50"
                />
                <span className="text-[11px] tabular-nums text-slate-400 shrink-0">
                  {t.priorities.length}/{PRIORITIES_PER_TRAVELER}
                </span>
                {travelers.length > 1 && (
                  <button
                    onClick={() =>
                      setTravelers((prev) => prev.filter((_, j) => j !== i))
                    }
                    disabled={loading}
                    title="Remove traveler"
                    className="w-7 h-7 rounded-lg border border-slate-200 flex items-center justify-center text-slate-400 hover:border-slate-400 hover:text-slate-700 transition shrink-0 disabled:opacity-50"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {CHIPS.map((label) => {
                  const on = t.priorities.includes(label);
                  return (
                    <button
                      key={label}
                      onClick={() => togglePriority(i, label)}
                      disabled={loading || (!on && full)}
                      className={
                        "text-[11px] font-medium px-2.5 py-1 rounded-full border transition " +
                        (on
                          ? "text-white border-transparent"
                          : full
                            ? "bg-white text-slate-300 border-slate-200 cursor-not-allowed"
                            : "bg-white text-slate-600 border-slate-300 hover:border-slate-500")
                      }
                      style={on ? { backgroundColor: color } : undefined}
                    >
                      {label}
                    </button>
                  );
                })}

                {/* Anything the chip list doesn't cover */}
                {t.priorities
                  .filter((p) => !CHIPS.includes(p))
                  .map((p) => (
                    <button
                      key={p}
                      onClick={() => togglePriority(i, p)}
                      disabled={loading}
                      className="text-[11px] font-medium px-2.5 py-1 rounded-full border border-transparent text-white transition flex items-center gap-1"
                      style={{ backgroundColor: color }}
                    >
                      {p} <X size={10} />
                    </button>
                  ))}
              </div>

              <div className="flex gap-1.5 mt-2.5">
                <input
                  value={custom[i] || ""}
                  onChange={(e) =>
                    setCustom((c) => ({ ...c, [i]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustom(i);
                    }
                  }}
                  placeholder="Something else…"
                  disabled={loading || full}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:opacity-50 w-44"
                />
                <button
                  onClick={() => addCustom(i)}
                  disabled={loading || full || !(custom[i] || "").trim()}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-full border border-slate-300 hover:bg-slate-50 transition disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </section>
          );
        })}

        {travelers.length < MAX_TRAVELERS && (
          <button
            onClick={() => setTravelers((prev) => [...prev, blankTraveler()])}
            disabled={loading}
            className="w-full py-2.5 rounded-xl border border-dashed border-slate-300 text-sm font-medium text-slate-500 hover:border-slate-500 hover:text-slate-800 transition flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Plus size={14} /> Add traveler
          </button>
        )}

        {error && (
          <div className="flex gap-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3 leading-relaxed">
            <AlertCircle size={14} className="shrink-0 mt-px" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={build}
            disabled={!ready || loading}
            className="flex-1 py-3 rounded-xl bg-slate-900 text-white text-sm font-semibold transition hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-900 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                Building the trip…
              </>
            ) : (
              <>
                Build the trip <ArrowRight size={15} />
              </>
            )}
          </button>
          {onSkip && (
            <button
              onClick={onSkip}
              disabled={loading}
              className="text-xs font-semibold text-slate-500 hover:text-slate-900 transition px-3 py-3 disabled:opacity-40"
            >
              Use the Lisbon sample
            </button>
          )}
        </div>

        {loading && (
          <p className="text-[11px] text-slate-400 text-center leading-relaxed">
            One model call builds 20–30 activities with real coordinates. This
            takes a moment.
          </p>
        )}
      </div>
    </div>
  );
}
