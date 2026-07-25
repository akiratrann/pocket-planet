import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sendFeedback } from '../data/api';
import { CATEGORIES } from '../data/categories';
import type { CategoryId, Destination } from '../types';

/**
 * Teach the system. Every action here is persisted as feedback the backend folds
 * into its learned state — so it "relearns" from your input and (via self-tuning)
 * generalizes the lesson to other locations.
 */
export default function FeedbackControls({
  destination,
  location,
}: {
  destination: Destination;
  location: string;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCats, setShowCats] = useState(false);
  const [note, setNote] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['guide'] });

  async function act(fn: () => Promise<{ learnedVersion: number }>, label: string) {
    setBusy(true);
    setStatus(null);
    try {
      const { learnedVersion } = await fn();
      setStatus(`${label} · learned v${learnedVersion}`);
      refresh();
    } catch (e) {
      setStatus(`Couldn't save (is the backend running?)`);
      void e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="feedback">
      <div className="feedback__title">🧠 Teach Pocket Planet</div>
      <div className="feedback__row">
        <button
          className="fbtn fbtn--up"
          disabled={busy}
          onClick={() =>
            act(() => sendFeedback({ location, name: destination.name, kind: 'promote', weight: 25 }), 'Promoted')
          }
        >
          ⬆︎ Recommend more
        </button>
        <button
          className="fbtn fbtn--down"
          disabled={busy}
          onClick={() =>
            act(() => sendFeedback({ location, name: destination.name, kind: 'demote', weight: 25 }), 'Demoted')
          }
        >
          ⬇︎ Recommend less
        </button>
        <button className="fbtn" disabled={busy} onClick={() => setShowCats((s) => !s)}>
          🏷️ Wrong category
        </button>
      </div>

      {showCats && (
        <div className="feedback__cats">
          {CATEGORIES.filter((c) => c.id !== destination.category).map((c) => (
            <button
              key={c.id}
              className="chip"
              disabled={busy}
              onClick={() =>
                act(
                  () =>
                    sendFeedback({
                      location,
                      name: destination.name,
                      kind: 'recategorize',
                      category: c.id as CategoryId,
                    }),
                  `Moved to ${c.label}`,
                ).then(() => setShowCats(false))
              }
            >
              {c.icon} {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="feedback__note">
        <input
          className="feedback__note-input"
          placeholder="Add a tip or correction…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          className="fbtn"
          disabled={busy || !note.trim()}
          onClick={() =>
            act(
              () => sendFeedback({ location, name: destination.name, kind: 'note', note }),
              'Note saved',
            ).then(() => setNote(''))
          }
        >
          Save
        </button>
      </div>

      {status && <div className="feedback__status">{status}</div>}
    </div>
  );
}
