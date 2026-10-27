/**
 * 全局导航栏 —— 常驻所有页面的唯一一条顶栏。
 *
 * 为什么要它：改动前每个页面（图谱/检索/下载/酶详情）各自复制了一份「品牌 +
 * 搜索 + 导航 + 工具」，而且各有微妙差异 —— 检索集在下载页消失、搜索框语义
 * 逐页变化、「检索集」在详情页被挤成竖排。用户没法建立稳定的心智模型。
 *
 * 分层原则（这是本次重构的核心）：
 *   全局栏 = 「去哪里」——品牌、三个主入口、跨页面工具（检索集 / BLAST /
 *            结构检索 / 队列 / 语言）
 *   页面工具条 = 「这一页做什么」——搜索框、模式切换、筛选、导出设置
 *
 * 所以这里**不放搜索框**：首页搜的是图谱、检索页搜的是结果集，语义不同，
 * 塞进全局栏只会重新制造歧义。
 */
import { Download, Languages, Network, Search } from 'lucide-react'
import type { View } from '../lib/entities'
import { LANGS, useLang, useT } from '../lib/i18n'
import { SearchSetControl } from './SearchSetControl'

export type NavView = View

const PRIMARY = [
  { view: 'home', label: 'Graph Atlas', icon: Network, hint: 'Overview' },
  { view: 'search', label: 'Search library', icon: Search, hint: 'Search library' },
  { view: 'downloads', label: 'Download queue', icon: Download, hint: 'Download queue' },
] as const

export function GlobalNav({
  view,
  onNavigate,
  searchSet,
  onSearchSetChange,
  queueCount,
  onOpenBlast,
  onOpenStructure,
}: {
  view: NavView
  onNavigate: (next: NavView) => void
  searchSet: string[]
  onSearchSetChange: (next: string[]) => void
  queueCount: number
  onOpenBlast: () => void
  onOpenStructure: () => void
}) {
  const t = useT()
  const { lang, setLang } = useLang()

  return (
    <header className="global-nav" role="banner">
      <button
        type="button"
        className="global-nav-brand"
        onClick={() => onNavigate('home')}
        title={t('Back to the Atlas home map')}
      >
        <span className="global-nav-logo">
          <img src="/starase-atlas-logo.png" alt="" />
        </span>
        <span className="global-nav-wordmark">Starase Atlas</span>
      </button>

      <nav className="global-nav-primary" aria-label={t('Global navigation')}>
        {PRIMARY.map(({ view: target, label, icon: Icon, hint }) => {
          // 酶详情页属于「检索」这一支，所以高亮检索。
          const active = view === target || (target === 'search' && view === 'enzyme')
          return (
            <button
              key={target}
              type="button"
              className={`global-nav-tab${active ? ' is-active' : ''}`}
              onClick={() => onNavigate(target)}
              aria-current={active ? 'page' : undefined}
              title={t(hint)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{t(label)}</span>
              {target === 'downloads' && queueCount > 0 && (
                <span className="global-nav-badge">{queueCount}</span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="global-nav-tools">
        <SearchSetControl value={searchSet} onChange={onSearchSetChange} />
        <button type="button" className="global-nav-tool" onClick={onOpenBlast}>BLAST</button>
        <button type="button" className="global-nav-tool" onClick={onOpenStructure}>{t('Structure search')}</button>
        <span className="global-nav-divider" aria-hidden="true" />
        <div className="global-nav-lang" role="group" aria-label="Language / 语言">
          <Languages size={13} aria-hidden="true" />
          {LANGS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`global-nav-lang-option${lang === option.value ? ' is-active' : ''}`}
              onClick={() => setLang(option.value)}
              title={option.title}
              aria-pressed={lang === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
