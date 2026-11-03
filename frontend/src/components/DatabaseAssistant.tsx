import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Bot, Loader2, Send, X } from 'lucide-react'
import { askDatabaseAssistant } from '../api'
import type { AssistantReply } from '../api'
import { useLang } from '../lib/i18n'

type Message = {
  question: string
  reply?: AssistantReply
  error?: string
}

export function DatabaseAssistant({
  enzymeId,
  searchSet,
  onOpenEnzyme,
  onOpenCompound,
  onSearch,
  onOpenPathway,
}: {
  enzymeId?: string
  searchSet: string[]
  onOpenEnzyme: (id: string) => void
  onOpenCompound: (id: string) => void
  onSearch: (query: string) => void
  onOpenPathway: (start: string, end: string) => void
}) {
  const { lang } = useLang()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [messages, busy])

  const ask = async (text: string) => {
    const question = text.trim()
    if (busy || question.length < 2) return
    setDraft('')
    setBusy(true)
    setMessages((current) => [...current, { question }])
    try {
      const reply = await askDatabaseAssistant({ question, enzymeId, sourceTypes: searchSet, language: lang })
      setMessages((current) => current.map((message, index) => index === current.length - 1 ? { ...message, reply } : message))
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Request failed'
      setMessages((current) => current.map((message, index) => index === current.length - 1 ? { ...message, error: detail } : message))
    } finally {
      setBusy(false)
    }
  }

  const examples = enzymeId
    ? (lang === 'zh' ? ['这个酶催化什么反应？', '这个酶的物种和分数是什么？'] : ['What reactions does this enzyme catalyze?', 'What is its organism and score?'])
    : (lang === 'zh' ? ['查找 limonene synthase', '查找 CHEBI:15384', '从 CHEBI:58057 到 CHEBI:15384 有通路吗？'] : ['Find limonene synthase', 'Find CHEBI:15384', 'From CHEBI:58057 to CHEBI:15384'])

  return (
    <div className="database-assistant">
      {open && (
        <section className="database-assistant-panel" role="dialog" aria-label={lang === 'zh' ? '数据库助手' : 'Database assistant'}>
          <header className="database-assistant-header">
            <span className="database-assistant-title"><Bot size={18} />{lang === 'zh' ? '数据库助手' : 'Database assistant'}</span>
            <button type="button" onClick={() => setOpen(false)} aria-label={lang === 'zh' ? '关闭助手' : 'Close assistant'}><X size={18} /></button>
          </header>
          <div className="database-assistant-context">
            {enzymeId
              ? (lang === 'zh' ? '正在参考当前酶记录与数据库检索结果' : 'Using this enzyme record and database search')
              : (lang === 'zh' ? '根据数据库记录回答，并提供可打开的条目' : 'Answers from database records with links')}
          </div>
          <div className="database-assistant-messages" ref={messagesRef} aria-live="polite">
            {messages.length === 0 && (
              <div className="database-assistant-welcome">
                <p>{lang === 'zh' ? '可以问我当前酶的信息，或查找数据库中的酶和化合物。' : 'Ask about this enzyme or find enzymes and compounds in the database.'}</p>
                <div className="database-assistant-examples">
                  {examples.map((example) => <button type="button" key={example} onClick={() => void ask(example)}>{example}</button>)}
                </div>
              </div>
            )}
            {messages.map((message, index) => (
              <div className="database-assistant-exchange" key={index}>
                <p className="database-assistant-question">{message.question}</p>
                {message.reply && (
                  <div className="database-assistant-answer">
                    <span className="database-assistant-mode">{message.reply.mode === 'ai' ? (lang === 'zh' ? 'AI 整理 · 基于数据库' : 'AI summary · database grounded') : (lang === 'zh' ? '数据库记录' : 'Database records')}</span>
                    <p>{message.reply.answer}</p>
                    {message.reply.references.length > 0 && (
                      <div className="database-assistant-references">
                        {message.reply.references.map((reference) => (
                          <button
                            type="button"
                            key={reference.kind + reference.id}
                            onClick={() => reference.kind === 'enzyme' ? onOpenEnzyme(reference.id) : onOpenCompound(reference.id)}
                          >
                            <span>{reference.label}<small>{reference.id}</small></span><ArrowRight size={14} />
                          </button>
                        ))}
                      </div>
                    )}
                    {message.reply.searchQuery && (
                      <button className="database-assistant-search" type="button" onClick={() => onSearch(message.reply!.searchQuery)}>
                        {lang === 'zh' ? '在检索页查看完整结果' : 'View full search results'} <ArrowRight size={14} />
                      </button>
                    )}
                    {message.reply.pathway && (
                      <button className="database-assistant-search" type="button" onClick={() => onOpenPathway(message.reply!.pathway!.start, message.reply!.pathway!.end)}>
                        {lang === 'zh' ? '在图谱中查看通路' : 'View pathway in graph'} <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                )}
                {message.error && <p className="database-assistant-error">{lang === 'zh' ? '查询失败，请稍后重试。' : 'Search failed. Please retry.'} <small>{message.error}</small></p>}
              </div>
            ))}
            {busy && <p className="database-assistant-loading"><Loader2 size={15} className="spin" />{lang === 'zh' ? '正在查询数据库…' : 'Searching database…'}</p>}
          </div>
          <form className="database-assistant-form" onSubmit={(event) => { event.preventDefault(); void ask(draft) }}>
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(draft) } }}
              placeholder={lang === 'zh' ? '询问酶、反应或化合物…' : 'Ask about enzymes, reactions or compounds…'}
              aria-label={lang === 'zh' ? '输入数据库问题' : 'Enter a database question'}
              rows={2}
              maxLength={500}
            />
            <button type="submit" disabled={busy || draft.trim().length < 2} aria-label={lang === 'zh' ? '发送问题' : 'Send question'}><Send size={17} /></button>
          </form>
        </section>
      )}
      <button className="database-assistant-trigger" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-label={lang === 'zh' ? '打开数据库助手' : 'Open database assistant'}>
        {open ? <X size={21} /> : <Bot size={23} />}
        {!open && <span>{lang === 'zh' ? '问数据库' : 'Ask Atlas'}</span>}
      </button>
    </div>
  )
}
