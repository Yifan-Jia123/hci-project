/**
 * 极简 i18n —— 不引第三方库。
 *
 * 为什么不用 react-i18next：这个站只有两种语言、没有复数/日期/表单化规则，
 * 一个 Context 加一张表就够；多装一个包对首屏体积是净负担。
 *
 * 用法：
 *   const t = useT()
 *   <button>{t('Search')}</button>
 *   <input placeholder={t('Filter by accession, name or organism…')} />
 *
 * 约定：key 就是英文原文。英文模式下 `t()` 原样返回，所以**漏翻不会变空白**，
 * 只会回退成英文。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ZH } from './i18n-zh'

export type Lang = 'en' | 'zh'

export const LANGS: { value: Lang; label: string; title: string }[] = [
  { value: 'zh', label: '中文', title: '切换到中文' },
  { value: 'en', label: 'EN', title: 'Switch to English' },
]

/** localStorage 键。与站点其它缓存一样按站点隔离。 */
const STORAGE_KEY = 'terpeneAtlas.lang'

export function translate(lang: Lang, key: string): string {
  if (lang === 'zh') {
    const hit = ZH[key]
    if (hit !== undefined) return hit
  }
  return key
}

function readStoredLang(): Lang {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'en' || raw === 'zh' ? raw : 'zh'
  } catch {
    // localStorage 不可用（隐私模式、被禁用）时退回默认值，不影响使用。
    return 'zh'
  }
}

type LangContextValue = {
  lang: Lang
  setLang: (next: Lang) => void
  t: (key: string) => string
}

const LangContext = createContext<LangContextValue>({
  lang: 'zh',
  setLang: () => {},
  t: (key) => translate('zh', key),
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang)

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 存不下就算了，仅影响下次打开时的默认语言。
    }
  }, [])

  // 让浏览器/读屏知道当前语言（作用于 lang 属性与连字符断词）。
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const value = useMemo<LangContextValue>(
    () => ({ lang, setLang, t: (key: string) => translate(lang, key) }),
    [lang, setLang],
  )

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

/** 只要翻译函数。 */
export function useT() {
  return useContext(LangContext).t
}

/** 需要读写当前语言时用（切换按钮）。 */
export function useLang() {
  const { lang, setLang } = useContext(LangContext)
  return { lang, setLang }
}
