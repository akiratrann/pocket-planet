import { useAppStore } from '../store/useAppStore';
import { LANGUAGES, useI18n } from '../i18n';

/** Compact language picker for the top bar. Changing it re-fetches the guide
 *  with localized place names and re-renders all UI strings. */
export default function LanguageSelector() {
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const { t } = useI18n();

  return (
    <label className="langsel" title={t('language')}>
      <span className="langsel__globe" aria-hidden="true">🌐</span>
      <select
        className="langsel__select"
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
        aria-label={t('language')}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
