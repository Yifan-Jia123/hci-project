/**
 * 语言切换按钮。
 *
 * 位置：视口右下角固定。
 *   - 右上角会和检索页/下载页 header 右上角的按钮打架（"N queued"、"Queue empty"），
 *     首页右上角还有缩放控件；
 *   - 抽屉的 z-index 是 1200，这里用 1100，被抽屉盖住 —— 不会挡住抽屉的关闭按钮。
 */
import { Languages } from 'lucide-react'
import { LANGS, useLang } from '../lib/i18n'

export function LanguageToggle() {
  const { lang, setLang } = useLang()

  return (
    <div className="lang-toggle" role="group" aria-label="Language / 语言">
      <Languages size={14} aria-hidden="true" />
      {LANGS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`lang-toggle-option${lang === option.value ? ' active' : ''}`}
          onClick={() => setLang(option.value)}
          title={option.title}
          aria-pressed={lang === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
