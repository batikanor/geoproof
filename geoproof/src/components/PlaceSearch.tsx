"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PlaceResult = {
  displayName: string;
  coord: [number, number];
  bbox: [number, number, number, number] | null;
};

type Props = {
  label: string;
  placeholder: string;
  value: PlaceResult | null;
  onChange: (place: PlaceResult | null) => void;
};

export function PlaceSearch({ label, placeholder, value, onChange }: Props) {
  const [query, setQuery] = useState<string>(value?.displayName ?? "");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<number | null>(null);
  const q = useMemo(() => query.trim(), [query]);

  useEffect(() => {
    setQuery(value?.displayName ?? "");
  }, [value?.displayName]);

  useEffect(() => {
    setError(null);
    if (!open) return;
    if (!q) {
      setResults([]);
      return;
    }

    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
    }

    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        const json = (await res.json()) as unknown;
        if (!res.ok) {
          const msg =
            typeof json === "object" && json !== null && typeof (json as { error?: unknown }).error === "string"
              ? (json as { error: string }).error
              : `Geocode failed: ${res.status}`;
          setError(msg);
          setResults([]);
          return;
        }

        const items =
          typeof json === "object" &&
          json !== null &&
          Array.isArray((json as { results?: unknown }).results)
            ? ((json as { results: unknown[] }).results as PlaceResult[])
            : [];
        setResults(items);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [q, open]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-zinc-700">{label}</label>
        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs font-medium text-zinc-500 hover:text-zinc-800"
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so click selection can register.
            window.setTimeout(() => setOpen(false), 120);
          }}
          placeholder={placeholder}
          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />

        {open ? (
          <div className="absolute z-10 mt-2 w-full overflow-hidden rounded-lg border border-zinc-200 bg-white shadow">
            <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
              <span>{loading ? "Searching…" : `${results.length} results`}</span>
              {error ? <span className="text-red-600">{error}</span> : null}
            </div>
            <ul className="max-h-56 overflow-auto">
              {results.map((r, idx) => (
                <li key={`${r.displayName}-${idx}`}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onChange(r);
                      setQuery(r.displayName);
                      setOpen(false);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm text-zinc-900 hover:bg-zinc-50"
                    title={r.displayName}
                  >
                    <div className="whitespace-normal leading-5">{r.displayName}</div>
                    <div className="mt-1 font-mono text-[11px] text-zinc-500">
                      [{r.coord[0].toFixed(5)}, {r.coord[1].toFixed(5)}]
                    </div>
                  </button>
                </li>
              ))}
              {!loading && results.length === 0 && !error ? (
                <li className="px-3 py-3 text-sm text-zinc-500">No results.</li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
