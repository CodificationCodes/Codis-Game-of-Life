import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Place search backed by Nominatim.
 *
 * Nominatim's usage policy caps requests at ~1/second and forbids hammering it
 * per keystroke, so queries are debounced, require three characters, and each
 * new query aborts the one in flight. Browsers cannot set User-Agent, so we
 * identify via the automatically-sent Referer as the policy permits.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const DEBOUNCE_MS = 450;
const MIN_CHARS = 3;

export interface Place {
  id: string;
  label: string;
  lng: number;
  lat: number;
  kind: string;
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  addresstype?: string;
}

interface Props {
  onPick(place: Place): void;
}

export function SearchBar({ onPick }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const skipNext = useRef(false);

  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      setOpen(false);
      setError(null);
      return;
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setBusy(true);
      setError(null);
      try {
        const url = `${ENDPOINT}?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: NominatimResult[] = await res.json();
        setResults(
          json.map((r) => ({
            id: String(r.place_id),
            label: r.display_name,
            lng: Number(r.lon),
            lat: Number(r.lat),
            kind: r.addresstype ?? r.type ?? 'place',
          })),
        );
        setActive(0);
        setOpen(true);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError('Search unavailable — try again.');
      } finally {
        setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  const choose = useCallback(
    (place: Place) => {
      skipNext.current = true;
      setQuery(place.label.split(',')[0]);
      setOpen(false);
      setResults([]);
      onPick(place);
    },
    [onPick],
  );

  return (
    <div className="search">
      <div className="search-field">
        <SearchIcon />
        <input
          value={query}
          placeholder="Search a city or address — try Tokyo, Paris, Lisbon…"
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={(e) => {
            if (!open || !results.length) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => (i + 1) % results.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => (i - 1 + results.length) % results.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {busy && <span className="spinner" aria-label="Searching" />}
        {query && !busy && (
          <button className="clear" onClick={() => setQuery('')} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      {error && <div className="search-error">{error}</div>}

      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((r, i) => {
            const [head, ...rest] = r.label.split(',');
            return (
              <li key={r.id}>
                <button
                  className={i === active ? 'active' : ''}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(r)}
                >
                  <span className="result-name">{head}</span>
                  <span className="result-detail">{rest.join(',').trim()}</span>
                  <span className="result-kind">{r.kind.replace(/_/g, ' ')}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M16.5 16.5 21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
