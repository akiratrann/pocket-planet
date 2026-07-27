import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useI18n } from '../i18n';
import { suggestPlaces, type PlaceSuggestion } from '../data/geocode';
import './searchbar-typeahead.css';

const EXAMPLES = ['Kyoto', 'Portugal', 'Cusco', 'Marrakesh', 'Queenstown', 'Hoi An'];

// The typeahead's own labels live here rather than in i18n.ts: that file is
// owned/edited elsewhere, and if these keys go missing the box would render raw
// key names ("search_no_matches") at the user. translate() returns the key
// itself when it is unknown, so that is exactly what we detect and fall back on.
const LABELS: Record<string, string> = {
  search_suggestions: 'Destinations',
  search_popular: 'Popular destinations',
  search_searching: 'Looking for places…',
  search_no_matches: 'No destinations match',
};

// Long enough that a normal typist finishes a word first (a 10-char query costs
// one request, not ten), short enough that the list still feels live.
const DEBOUNCE_MS = 280;
const MIN_QUERY = 2;

const KIND_ICON: Record<string, string> = {
  country: '🏳️',
  state: '🗺️',
  province: '🗺️',
  region: '🗺️',
  county: '🗺️',
  island: '🏝️',
  isle: '🏝️',
  archipelago: '🏝️',
  national_park: '🌲',
  city: '🏙️',
  town: '🏘️',
  municipality: '🏘️',
  village: '🏡',
  hamlet: '🏡',
};

function iconFor(kind: string): string {
  return KIND_ICON[kind] ?? '📍';
}

/** Fallback rows for an empty query — the same starter destinations as the chips. */
function popularSuggestions(): PlaceSuggestion[] {
  return EXAMPLES.map((name) => ({
    id: `popular:${name}`,
    name,
    context: '',
    kind: 'popular',
    lat: 0,
    lon: 0,
  }));
}

export default function SearchBar({ isLoading }: { isLoading: boolean }) {
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const { t, lang } = useI18n();
  /** t() for the typeahead's labels, with a built-in English fallback. */
  const tx = (key: keyof typeof LABELS) => {
    const v = t(key);
    return v === key ? LABELS[key] : v;
  };
  const [text, setText] = useState(query);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PlaceSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => setText(query), [query]);

  const trimmed = text.trim();
  const popular = useMemo(popularSuggestions, []);
  // Only an *empty* box falls back to the starter destinations. Showing
  // "Popular destinations" after one character reads as an answer to what was
  // typed, when it is really just the chip row repeated.
  const showPopular = trimmed.length === 0;
  const list = showPopular ? popular : items;

  // One debounced, cancellable lookup per settled query. The cleanup both clears
  // the pending timer and aborts the in-flight request, so a fast typist never
  // has more than one Nominatim/Photon call outstanding — and a stale reply can
  // never overwrite the list for a newer query.
  useEffect(() => {
    if (!open || trimmed.length < MIN_QUERY) {
      setBusy(false);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      suggestPlaces(trimmed, { lang, signal: ctrl.signal })
        .then((found) => {
          if (ctrl.signal.aborted) return;
          setItems(found);
          setActive(-1);
          setBusy(false);
        })
        .catch(() => {
          if (ctrl.signal.aborted) return;
          setItems([]);
          setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [trimmed, lang, open]);

  // Keep the keyboard-highlighted row visible when the list scrolls.
  useEffect(() => {
    if (active < 0) return;
    document
      .getElementById(`${listId}-opt-${active}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const submit = (value: string) => {
    const v = value.trim();
    if (v) setQuery(v);
  };

  const choose = (s: PlaceSuggestion) => {
    setOpen(false);
    setActive(-1);
    setText(s.name);
    submit(s.name);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (!list.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => {
        const next = i + step;
        if (next < 0) return list.length - 1;
        if (next >= list.length) return 0;
        return next;
      });
    } else if (e.key === 'Enter') {
      // Only intercept when a row is actually highlighted; otherwise the form
      // submits the free-form text exactly as it did before the typeahead.
      if (open && active >= 0 && list[active]) {
        e.preventDefault();
        choose(list[active]);
      } else {
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  // A single character is below Nominatim/Photon's useful threshold, so there is
  // nothing honest to show for it — leave the panel shut rather than flash an
  // empty box between "" and the first real lookup.
  const panelOpen =
    open && (showPopular ? list.length > 0 : trimmed.length >= MIN_QUERY);
  // Guard against a stale index outliving the list it pointed into.
  const activeId =
    panelOpen && active >= 0 && active < list.length
      ? `${listId}-opt-${active}`
      : undefined;

  return (
    <div className="searchbar">
      <div className="sb-typeahead" ref={wrapRef}>
        <form
          className="searchbar__form"
          onSubmit={(e) => {
            e.preventDefault();
            setOpen(false);
            setActive(-1);
            submit(text);
          }}
        >
          <span className="searchbar__icon">{isLoading ? '⏳' : '🔍'}</span>
          <input
            ref={inputRef}
            className="searchbar__input"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={t('search_placeholder')}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('search_aria')}
            role="combobox"
            aria-expanded={panelOpen}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              panelOpen && active >= 0 ? `${listId}-opt-${active}` : undefined
            }
          />
          {text && (
            <button
              type="button"
              className="searchbar__clear"
              onClick={() => {
                setText('');
                setItems([]);
                setActive(-1);
                inputRef.current?.focus();
              }}
              aria-label={t('clear')}
            >
              ✕
            </button>
          )}
        </form>

        {panelOpen && (
          <ul className="sb-typeahead__panel" id={listId} role="listbox" aria-label={t('search_suggestions')}>
            <li className="sb-typeahead__head" aria-hidden="true">
              {showPopular ? t('search_popular') : t('search_suggestions')}
            </li>
            {list.map((s, i) => (
              <li key={s.id} role="presentation">
                <button
                  type="button"
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={
                    'sb-typeahead__option' +
                    (i === active ? ' sb-typeahead__option--active' : '')
                  }
                  // Keep focus in the input so the click doesn't close the panel
                  // via blur before the selection is handled.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(s)}
                >
                  <span className="sb-typeahead__icon" aria-hidden="true">
                    {iconFor(s.kind)}
                  </span>
                  <span className="sb-typeahead__text">
                    <span className="sb-typeahead__name">{s.name}</span>
                    {s.context && (
                      <span className="sb-typeahead__context">{s.context}</span>
                    )}
                  </span>
                  {!showPopular && <span className="sb-typeahead__kind">{s.kind}</span>}
                </button>
              </li>
            ))}
            {!showPopular && !list.length && (
              <li className="sb-typeahead__note">
                {busy ? t('search_searching') : `${t('search_no_matches')} “${trimmed}”`}
              </li>
            )}
          </ul>
        )}

        <p className="sb-typeahead__sr" role="status" aria-live="polite">
          {panelOpen && !showPopular && !busy
            ? `${list.length} ${t('search_suggestions')}`
            : ''}
        </p>
      </div>

      <div className="searchbar__examples">
        {EXAMPLES.map((e) => (
          <button key={e} className="chip chip--ghost" onClick={() => submit(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
