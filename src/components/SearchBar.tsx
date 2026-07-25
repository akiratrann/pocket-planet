import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';

const EXAMPLES = ['Kyoto', 'Portugal', 'Cusco', 'Marrakesh', 'Queenstown', 'Hoi An'];

export default function SearchBar({ isLoading }: { isLoading: boolean }) {
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const [text, setText] = useState(query);

  useEffect(() => setText(query), [query]);

  const submit = (value: string) => {
    const v = value.trim();
    if (v) setQuery(v);
  };

  return (
    <div className="searchbar">
      <form
        className="searchbar__form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <span className="searchbar__icon">{isLoading ? '⏳' : '🔍'}</span>
        <input
          className="searchbar__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search a city, country or town…"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search a destination"
        />
        {text && (
          <button
            type="button"
            className="searchbar__clear"
            onClick={() => setText('')}
            aria-label="Clear"
          >
            ✕
          </button>
        )}
      </form>
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
