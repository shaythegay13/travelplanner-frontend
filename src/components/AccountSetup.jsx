"use client";

import React, { useState } from "react";
import {
  Sparkles,
  Loader2,
  ArrowRight,
  AlertCircle,
  ExternalLink,
  Check,
} from "lucide-react";
import { CHIPS, PALETTE, PRIORITIES_PER_TRAVELER } from "@/lib/priorities";

const L = "text-[10px] uppercase tracking-[0.16em] font-semibold text-slate-400";
const CARD = "bg-white border border-slate-200 rounded-xl";

const CONFIDENCE_COPY = {
  high: ["Clear signal", "bg-emerald-50 text-emerald-700"],
  medium: ["Some signal", "bg-amber-50 text-amber-700"],
  low: ["Thin signal — worth checking", "bg-slate-100 text-slate-500"],
};

export default function AccountSetup({ onReady, onSkip }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [picked, setPicked] = useState([]);

  const research = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: handle.trim(), name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setResult(data);
      // Pre-select what it found, but the user still owns the final list.
      setPicked([...(data.priorities || []), ...(data.custom || [])].slice(
        0,
        PRIORITIES_PER_TRAVELER
      ));
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (label) =>
    setPicked((prev) => {
      if (prev.includes(label)) return prev.filter((p) => p !== label);
      if (prev.length >= PRIORITIES_PER_TRAVELER) return prev;
      return [...prev, label];
    });

  const confirm = () =>
    onReady({ name: name.trim(), priorities: picked, sources: result?.sources || [] });

  const canResearch = handle.trim() && !loading;
  const canContinue = name.trim() && picked.length > 0;

  // Chips to offer: the canonical list plus any custom labels research suggested.
  const offered = [
    ...CHIPS,
    ...picked.filter((p) => !CHIPS.includes(p)),
  ];

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 font-sans antialiased">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-[720px] mx-auto px-6 py-5">
          <div className={L}>Step 1 of 2</div>
          <h1 className="text-2xl font-bold tracking-tight leading-none mt-1">
            Set up your profile
          </h1>
          <p className="text-sm text-slate-500 mt-2 leading-relaxed">
            Tell us who you are. If you&apos;d like, point us at something public you
            wrote or posted and we&apos;ll suggest your travel priorities from it.
          </p>
        </div>
      </header>

      <div className="max-w-[720px] mx-auto px-6 py-6 space-y-4">
        <section className={CARD + " p-4"}>
          <label className={L + " block mb-2"} htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shay"
            disabled={loading}
            className="w-full text-lg font-semibold px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:opacity-50"
          />
        </section>

        <section className={CARD + " p-4"}>
          <div className="flex items-center gap-1.5 mb-2">
            <Sparkles size={13} className="text-slate-400" />
            <span className={L}>Import preferences · optional</span>
          </div>

          <p className="text-[12px] text-slate-500 leading-relaxed mb-3">
            Paste a link to <span className="font-semibold">your own</span> public
            profile — a travel blog, personal site, or <code>@handle</code>. We
            search that page and suggest priorities from what it says. You review
            everything before it&apos;s used, and nothing is stored.
          </p>

          <div className="flex gap-1.5">
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canResearch) {
                  e.preventDefault();
                  research();
                }
              }}
              placeholder="myblog.com  ·  @handle  ·  instagram.com/you"
              disabled={loading}
              className="flex-1 text-sm px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:opacity-50"
            />
            <button
              onClick={research}
              disabled={!canResearch}
              className="text-xs font-semibold px-4 rounded-lg bg-slate-900 text-white transition hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-900 flex items-center gap-1.5 shrink-0"
            >
              {loading ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Reading
                </>
              ) : (
                "Research"
              )}
            </button>
          </div>

          <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
            We only look at the link you give us. We don&apos;t search for you by
            name — too many people share one, and the result would be someone else.
          </p>

          {error && (
            <div className="flex gap-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5 mt-3 leading-relaxed">
              <AlertCircle size={14} className="shrink-0 mt-px" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="mt-3 pt-3 border-t border-slate-100">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className={L}>What we found</span>
                {(() => {
                  const [text, cls] =
                    CONFIDENCE_COPY[result.confidence] || CONFIDENCE_COPY.low;
                  return (
                    <span
                      className={
                        "text-[10px] font-semibold px-2 py-0.5 rounded-full " + cls
                      }
                    >
                      {text}
                    </span>
                  );
                })()}
                {result.degraded && (
                  <span
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700"
                    title="The language model was unavailable, so these came from keyword matching."
                  >
                    Keyword match only
                  </span>
                )}
              </div>

              {result.summary && (
                <p className="text-[12px] text-slate-600 leading-relaxed mb-2">
                  {result.summary}
                </p>
              )}

              {result.sources?.length > 0 && (
                <ul className="space-y-0.5 mb-1">
                  {result.sources.slice(0, 4).map((s) => (
                    <li key={s.url} className="text-[11px] truncate">
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-400 hover:text-slate-700 transition inline-flex items-center gap-1"
                      >
                        <ExternalLink size={9} className="shrink-0" />
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className={CARD + " p-4"}>
          <div className="flex items-baseline justify-between mb-2">
            <span className={L}>
              {result ? "Confirm your priorities" : "Pick your priorities"}
            </span>
            <span className="text-[11px] tabular-nums text-slate-400">
              {picked.length}/{PRIORITIES_PER_TRAVELER}
            </span>
          </div>

          {result && (
            <p className="text-[11px] text-slate-400 mb-2.5 leading-relaxed">
              Suggestions are pre-selected. Change anything that isn&apos;t right.
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            {offered.map((label) => {
              const on = picked.includes(label);
              const full = picked.length >= PRIORITIES_PER_TRAVELER;
              const suggested =
                result &&
                [...(result.priorities || []), ...(result.custom || [])].includes(
                  label
                );
              return (
                <button
                  key={label}
                  onClick={() => toggle(label)}
                  disabled={!on && full}
                  className={
                    "text-[11px] font-medium px-2.5 py-1 rounded-full border transition inline-flex items-center gap-1 " +
                    (on
                      ? "text-white border-transparent"
                      : full
                        ? "bg-white text-slate-300 border-slate-200 cursor-not-allowed"
                        : suggested
                          ? "bg-white text-slate-700 border-slate-400 border-dashed hover:border-slate-600"
                          : "bg-white text-slate-600 border-slate-300 hover:border-slate-500")
                  }
                  style={on ? { backgroundColor: PALETTE[0] } : undefined}
                >
                  {on && <Check size={10} />}
                  {label}
                </button>
              );
            })}
          </div>
        </section>

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={confirm}
            disabled={!canContinue}
            className="flex-1 py-3 rounded-xl bg-slate-900 text-white text-sm font-semibold transition hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-900 flex items-center justify-center gap-2"
          >
            Continue <ArrowRight size={15} />
          </button>
          <button
            onClick={onSkip}
            className="text-xs font-semibold text-slate-500 hover:text-slate-900 transition px-3 py-3"
          >
            Skip this
          </button>
        </div>
      </div>
    </div>
  );
}
