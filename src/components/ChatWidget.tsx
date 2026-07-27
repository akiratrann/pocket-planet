import { useEffect, useMemo, useRef, useState } from 'react';
import { askChat, type ChatContext, type ChatMessage } from '../data/api';
import { useI18n } from '../i18n';
import type { Guide } from '../types';

/** Minimal inline formatter: **bold** + line breaks + bullet lines. */
function renderRich(text: string) {
  return text.split('\n').map((line, i) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    return (
      <span key={i} className="chatmsg__line">
        {parts.map((p, j) =>
          p.startsWith('**') && p.endsWith('**') ? (
            <strong key={j}>{p.slice(2, -2)}</strong>
          ) : (
            <span key={j}>{p}</span>
          ),
        )}
        {i < text.split('\n').length - 1 && <br />}
      </span>
    );
  });
}

interface Msg extends ChatMessage {
  suggestions?: string[];
}

export default function ChatWidget({ guide }: { guide?: Guide }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Ground the assistant in exactly what the user is viewing. Keep the top picks
  // per CATEGORY (not just overall) so food, nightlife, stays etc. are always
  // represented even when sights dominate the raw ranking.
  const context = useMemo<ChatContext | undefined>(() => {
    if (!guide) return undefined;
    const byCat = new Map<string, typeof guide.destinations>();
    for (const d of guide.destinations) {
      const arr = byCat.get(d.category) ?? [];
      arr.push(d);
      byCat.set(d.category, arr);
    }
    const picks = [...byCat.values()].flatMap((arr) =>
      [...arr].sort((a, b) => b.score - a.score).slice(0, 12),
    );
    return {
      location: guide.title,
      destinations: picks.map((d) => ({
        name: d.name,
        category: d.category,
        score: d.score,
        rank: d.rank,
        description: d.description,
        reasons: d.reasons,
      })),
      opinions: guide.meta?.opinions,
      advice: guide.advice.map((a) => ({ title: a.title, body: a.body })),
    };
  }, [guide]);

  const welcomeSuggestions = useMemo(() => {
    const at = guide ? ` in ${guide.title}` : '';
    return [
      `Best things to do${at}`,
      `Where to eat${at}`,
      guide ? `Is ${guide.title} worth visiting?` : 'Where should I travel next?',
      `Plan a 3-day itinerary${at}`,
    ];
  }, [guide]);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy, open]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setInput('');
    setBusy(true);
    try {
      const reply = await askChat({ message, history, context, lang });
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: reply.answer, suggestions: reply.suggestions },
      ]);
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: t('chat_offline') }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!open && (
        <button
          className="chat-fab"
          onClick={() => setOpen(true)}
          aria-label={t('chat_open')}
          title={t('chat_open')}
        >
          💬
        </button>
      )}

      {open && (
        <section className="chat" role="dialog" aria-label={t('chat_title')}>
          <header className="chat__header">
            <span className="chat__title">💬 {t('chat_title')}</span>
            <div className="chat__actions">
              {messages.length > 0 && (
                <button className="chat__icon" onClick={() => setMessages([])} title={t('chat_clear')}>
                  🗑️
                </button>
              )}
              <button className="chat__icon" onClick={() => setOpen(false)} aria-label="Close" title="Close">
                ✕
              </button>
            </div>
          </header>

          <div className="chat__scroll" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="chatmsg chatmsg--assistant">
                <div className="chatmsg__bubble">{t('chat_welcome')}</div>
                <div className="chat__chips">
                  {welcomeSuggestions.map((s) => (
                    <button key={s} className="chat__chip" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={'chatmsg chatmsg--' + m.role}>
                <div className="chatmsg__bubble">{renderRich(m.content)}</div>
                {m.role === 'assistant' && m.suggestions && i === messages.length - 1 && !busy && (
                  <div className="chat__chips">
                    {m.suggestions.map((s) => (
                      <button key={s} className="chat__chip" onClick={() => send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {busy && (
              <div className="chatmsg chatmsg--assistant">
                <div className="chatmsg__bubble chatmsg__bubble--typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>

          <form
            className="chat__input-row"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              className="chat__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('chat_placeholder')}
              aria-label={t('chat_placeholder')}
            />
            <button className="chat__send" type="submit" disabled={!input.trim() || busy}>
              {t('chat_send')}
            </button>
          </form>
        </section>
      )}
    </>
  );
}
