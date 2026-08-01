import { useQuery } from '@tanstack/react-query';
import { CATEGORY_MAP } from '../data/categories';
import { fetchPersonal, type PersonalPick } from '../data/api';
import { useAppStore } from '../store/useAppStore';
import { useI18n } from '../i18n';
import './foryou.css';

/**
 * The signed-in reader's own shortlist for the guide they are looking at.
 *
 * Everything here is derived from ONE thing: the places this account has saved
 * (pins + itinerary stops), which is the only per-user state the backend keeps.
 * So every pick can name its evidence — "because you saved 3 × Museums &
 * Culture" — and does. There is no taste model, no inferred profile and no
 * collaborative filtering behind it, and the panel is careful not to imply one.
 *
 * It also does not pretend to change the guide. Scores and ranks are global (and
 * cached for everybody); this is a filter over them, and the note at the bottom
 * says exactly that so a reader never wonders whether their 86 is someone else's
 * 86.
 *
 * Signed out, it renders nothing at all rather than a teaser: there is no signal
 * to personalize from, and a locked box in the middle of the list would be an
 * advert, not a feature.
 */
export default function ForYouPanel({ location }: { location: string }) {
  const authUser = useAppStore((s) => s.authUser);
  const select = useAppStore((s) => s.select);
  const { t, lang } = useI18n();

  const { data } = useQuery({
    // Keyed by account as well as guide: logging out and in as someone else
    // must not show the previous person's shortlist.
    queryKey: ['personal', location, lang, authUser?.id ?? null],
    queryFn: () => fetchPersonal(location, lang),
    enabled: !!authUser,
    staleTime: 60_000,
  });

  if (!authUser || !data) return null;

  const hasSignal = data.taste.length > 0;

  return (
    <section className="foryou">
      <div className="foryou__head">
        <h3 className="foryou__title">
          ✨ {t('for_you')}
          {data.name ? `, ${data.name}` : ''}
        </h3>
        {hasSignal && (
          <span className="foryou__basis">
            {t('for_you_basis')}: {data.savedTotal} {t('places')}
            {data.savedHere > 0 ? ` · ${data.savedHere} ${t('saved_here')}` : ''}
          </span>
        )}
      </div>

      {!hasSignal ? (
        <p className="foryou__empty">{t('for_you_empty')}</p>
      ) : data.picks.length === 0 ? (
        <p className="foryou__empty">{t('for_you_none')}</p>
      ) : (
        <>
          <ul className="foryou__picks">
            {data.picks.map((p) => (
              <Pick key={p.id} pick={p} onSelect={() => select(p.id)} />
            ))}
          </ul>
          <p className="foryou__note">{t('for_you_note')}</p>
        </>
      )}
    </section>
  );
}

function Pick({ pick, onSelect }: { pick: PersonalPick; onSelect: () => void }) {
  const { t } = useI18n();
  const cat = CATEGORY_MAP[pick.category];
  const because = CATEGORY_MAP[pick.because.category];
  return (
    <li className="foryou__pick">
      <button className="foryou__btn" onClick={onSelect} style={{ ['--cat-color' as string]: cat.color }}>
        <span className="foryou__icon" aria-hidden="true">
          {cat.icon}
        </span>
        <span className="foryou__text">
          <span className="foryou__name">{pick.name}</span>
          {/* The reason is a fact about the reader's own saves, not a claim
              about the place. Kept next to the name so the two are read
              together. */}
          <span className="foryou__why">
            {t('for_you_because')}: {pick.because.saved} × {t('cat_' + pick.because.category)}{' '}
            <span aria-hidden="true">{because.icon}</span>
          </span>
        </span>
        <span className="foryou__rank">#{pick.rank}</span>
      </button>
    </li>
  );
}
