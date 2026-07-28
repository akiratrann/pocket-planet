import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchCapabilities, sendFeedback, type Capabilities } from '../data/api';
import { CATEGORIES } from '../data/categories';
import { useAppStore } from '../store/useAppStore';
import { useI18n } from '../i18n';
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
  const { t } = useI18n();
  const [status, setStatus] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  // Re-ask when the signed-in identity changes: logging in or out has to move
  // these controls without a reload.
  const authUser = useAppStore((s) => s.authUser);

  useEffect(() => {
    let live = true;
    fetchCapabilities().then((c) => {
      if (live) setCaps(c);
    });
    return () => {
      live = false;
    };
  }, [authUser?.id]);

  // Assume not permitted until the answer arrives — better a control that
  // appears a moment late than one that appears and then 401s.
  const canFeedback = caps?.canFeedback ?? false;
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
      // Report what actually went wrong. This used to blame the backend being
      // down, which became misleading once feedback started requiring an
      // account: a 401 was shown to the user as a server outage.
      setStatus((e as Error).message || t('feedback_failed'));
    } finally {
      setBusy(false);
    }
  }

  // Writing feedback needs an account (the endpoint enforces it). Say so
  // instead of offering controls that fail.
  if (!canFeedback) {
    return (
      <div className="feedback">
        <div className="feedback__title">🧠 {t('feedback_title')}</div>
        <p className="feedback__signin">{t('feedback_signin')}</p>
      </div>
    );
  }

  return (
    <div className="feedback">
      <div className="feedback__title">🧠 {t('feedback_title')}</div>
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
