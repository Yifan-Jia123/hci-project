import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  Menu,
  Network,
  Search,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import { entities as mockEntities, filterOptions as mockFilterOptions, graphEdges as mockGraphEdges, graphNodes as mockGraphNodes } from './data'
import { loadApiDataset } from './api'
import type { BlastPayload, BlastSession } from './api'
import { EnzymeDetailView } from './graphExperience'
import { BlastDrawer } from './components/BlastDrawer'
import { GlobalNav } from './components/GlobalNav'
import { StructureSearchDrawer } from './components/StructureSearchDrawer'
import { useT } from './lib/i18n'
import { DownloadsPage } from './pages/DownloadsPage'
import { HomePage } from './pages/HomePage'
import { SearchResultsPage } from './pages/SearchResultsPage'
import { getExternalRecordUrl, isExportableKind, looksLikeProteinSequence, matchesFilters } from './lib/entities'
import type { FilterState, SearchKind, View } from './lib/entities'
import type { Entity } from './types'
import { isBlastSession, isEntity, isRecord, isString, isStringArray, useCachedState } from './lib/browserCache'
import { useAppRoute } from './lib/routes'
import type { MapSearchRoute } from './lib/routes'

let entities = mockEntities
let filterOptions = mockFilterOptions
let graphEdges = mockGraphEdges
let graphNodes = mockGraphNodes

const getEntity = (id: string) => entities.find((entity) => entity.id === id)
type QueueEntry = string | Entity

const navigation = [
  { view: 'home', label: 'Overview', icon: Sparkles },
  { view: 'search', label: 'Search library', icon: Search },
  { view: 'downloads', label: 'Download queue', icon: Download },
] as const

function App() {
  const t = useT()
  const { route, navigate, goBack } = useAppRoute()
  const view = route.view
  const [cachedQuery, setQuery] = useCachedState('query', '', isString)
  const query = view === 'search' ? route.query ?? '' : cachedQuery
  const [searchKind, setSearchKind] = useCachedState<SearchKind>('searchKind', 'all', (value): value is SearchKind => isString(value) && ['all', 'compound', 'enzyme', 'reaction', 'pathway'].includes(value))
  const selectedId = route.enzymeId ?? null
  const [selectedSpecies, setSelectedSpecies] = useCachedState('species', filterOptions.species[0], isString)
  const [selectedClass, setSelectedClass] = useCachedState('compoundClass', filterOptions.classes[0], isString)
  const [selectedFamily, setSelectedFamily] = useCachedState('enzymeFamily', filterOptions.families[0], isString)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [downloadedIds, setDownloadedIds] = useCachedState<string[]>('downloadedIds', [], isStringArray)
  const [queuedEntitiesById, setQueuedEntitiesById] = useCachedState<Record<string, Entity>>('queuedEntities', {}, (value): value is Record<string, Entity> => isRecord(value) && Object.entries(value).every(([id, entity]) => isEntity(entity) && entity.id === id))
  const [datasetRevision, setDatasetRevision] = useState(0)
  /**
   * 首页地图现在是**常驻**的（离开首页只隐藏、不卸载），所以它内部的 scope/通路
   * 现场不会自己消失 —— `resetHome` 想清干净就必须显式通知它一次。
   * 递增值；地图侧靠比对 nonce 只执行一次。
   */
  const [mapResetNonce, setMapResetNonce] = useState(0)
  /**
   * 地图检索的「再来一次」计数器。URL 决定**跑什么**，它决定**何时再跑一遍**：
   * 同一个词连按两次回车时目标 URL 与当前地址一模一样，`navigate` 会提前 return，
   * 光比对规格发现不了第二次提交。
   */
  const [mapSearchNonce, setMapSearchNonce] = useState(0)
  const [blastOpen, setBlastOpen] = useState(false)
  /**
   * 结构检索抽屉提到这一层 —— 它原来是四个页面各开一份实例，
   * 全局导航栏只有一个「结构检索」入口，所以只能有一个抽屉。
   */
  const [structureOpen, setStructureOpen] = useState(false)
  /** Last completed BLAST run, shown through the keyword-search table/map result views. */
  const [blastSession, setBlastSession] = useCachedState<BlastSession | null>('blastSession', null, isBlastSession)
  /** One-shot hand-off telling the home map to scope itself to the active BLAST session. */
  const [autoBlastScope, setAutoBlastScope] = useState<{ sessionId: number; nonce: number } | null>(null)
  /**
   * 搜索集（search set）：**检索范围**，不是显示筛选。空数组 = 全部 ——
   * 沿用全仓库「空数组即不过滤」的约定（没有 `all` 哨兵值）。
   *
   * 它管的是取数，不管下载 —— 下载路径一行都不看这个值。
   */
  const [searchSet, setSearchSet] = useCachedState<string[]>('searchSet', [], isStringArray)

  useEffect(() => {
    setSidebarOpen(false)
    setBlastOpen(false)
    if (route.view === 'search') setQuery(route.query ?? '')
  }, [route, setQuery])

  useEffect(() => {
    let cancelled = false

    loadApiDataset()
      .then((dataset) => {
        if (cancelled || dataset.entities.length === 0 || dataset.graphNodes.length === 0) return

        entities = dataset.entities
        filterOptions = dataset.filterOptions
        graphEdges = dataset.graphEdges
        graphNodes = dataset.graphNodes

        setSelectedSpecies((current) => dataset.filterOptions.species.includes(current) ? current : dataset.filterOptions.species[0] || mockFilterOptions.species[0])
        setSelectedClass((current) => dataset.filterOptions.classes.includes(current) ? current : dataset.filterOptions.classes[0] || mockFilterOptions.classes[0])
        setSelectedFamily((current) => dataset.filterOptions.families.includes(current) ? current : dataset.filterOptions.families[0] || mockFilterOptions.families[0])
        setDatasetRevision((revision) => revision + 1)
      })
      .catch((error) => {
        console.warn('Unable to load backend dataset; using mock data.', error)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const filters = { query, searchKind, species: selectedSpecies, compoundClass: selectedClass, enzymeFamily: selectedFamily }
  const selected = selectedId ? getEntity(selectedId) : undefined
  const downloadedItems = useMemo(
    () => downloadedIds.map((id) => getEntity(id) || queuedEntitiesById[id]).filter((entity): entity is Entity => Boolean(entity)),
    [downloadedIds, queuedEntitiesById, datasetRevision],
  )
  const queuedIds = useMemo(() => new Set(downloadedIds), [downloadedIds])

  const visibleNodeIds = useMemo(
    () =>
      new Set(
        graphNodes
          .filter((node) => matchesFilters(getEntity(node.id), filters, filterOptions))
          .map((node) => node.id),
      ),
    [filters, datasetRevision],
  )

  const routeCount = new Set(graphEdges.map((edge) => edge.edgeGroupId || edge.reactionId)).size
  const queueCount = downloadedItems.length
  const visibleNodeCount = visibleNodeIds.size
  const visibleEdgeCount = graphEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)).length

  const rememberQueuedEntity = (entry: QueueEntry) => {
    const entity = typeof entry === 'string' ? getEntity(entry) : entry
    if (!entity) return
    setQueuedEntitiesById((current) => ({ ...current, [entity.id]: entity }))
  }

  const forgetQueuedEntity = (id: string) => {
    setQueuedEntitiesById((current) => {
      if (!current[id]) return current
      const { [id]: _removed, ...rest } = current
      return rest
    })
  }

  const removeFromQueue = (id: string) => {
    setDownloadedIds((current) => current.filter((item) => item !== id))
    forgetQueuedEntity(id)
  }

  const toggleQueue = (entry: QueueEntry) => {
    const id = typeof entry === 'string' ? entry : entry.id
    const alreadyQueued = downloadedIds.includes(id)

    // Guard at the queue itself: a compound or bare reaction has no exportable
    // payload, so nothing may put one in front of the download pages. Removal is
    // never gated — an id the dataset cannot resolve any more must still leave.
    if (!alreadyQueued) {
      const kind = typeof entry === 'string' ? getEntity(entry)?.kind : entry.kind
      if (!kind || !isExportableKind(kind)) return
    }

    if (alreadyQueued) {
      forgetQueuedEntity(id)
    } else {
      rememberQueuedEntity(entry)
    }
    setDownloadedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  /**
   * 批量入队 —— 合并抽屉的「Queue all N entries」用。
   *
   * 不能循环调 `toggleQueue`：那里每次都要 `downloadedIds.includes(id)`（O(n)）
   * 并展开整个 `queuedEntitiesById`（O(n)），3,595 条串行就是 O(n²) ≈ 1,300 万次
   * 操作 —— 本身就成了新的卡顿源。这里一次 `setDownloadedIds` + 一次
   * `setQueuedEntitiesById`。
   *
   * `isExportableKind` 那道闸门照旧（与 `toggleQueue` 同一判据）：
   * 队列不许出现没有导出载荷的条目。
   * 已经在队列里的条目保持原样（不重复、也不被移除）—— 「Queue all」是补充动作。
   */
  const queueEntities = (entries: Entity[]) => {
    if (entries.length === 0) return
    const incoming = new Map<string, Entity>()
    entries.forEach((entry) => {
      if (!isExportableKind(entry.kind)) return
      if (getEntity(entry.id)) return // 数据集里有的，靠 id 就能解析出来，不必存整份
      if (!incoming.has(entry.id)) incoming.set(entry.id, entry)
    })
    if (incoming.size === 0) return

    setDownloadedIds((current) => [...current, ...[...incoming.keys()].filter((id) => !current.includes(id))])
    setQueuedEntitiesById((current) => {
      const next = { ...current }
      incoming.forEach((entry, id) => {
        if (!next[id]) next[id] = entry
      })
      return next
    })
  }

  const clearQueue = () => {
    setDownloadedIds([])
    setQueuedEntitiesById({})
  }

  const openRecord = (entity: Entity) => {
    const url = getExternalRecordUrl(entity)
    // A pathway queued from the map is a search artifact with no external record.
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }


  const goTo = (nextView: View, id?: string, options?: { query?: string; blast?: boolean }) => {
    navigate({
      view: nextView === 'structure' ? 'home' : nextView,
      enzymeId: nextView === 'enzyme' ? id : undefined,
      query: nextView === 'search' ? options?.query ?? query : undefined,
      blast: nextView === 'search' ? options?.blast ?? Boolean(blastSession) : undefined,
    })
    setSidebarOpen(false)
  }

  const openBlast = () => {
    setBlastOpen(true)
  }

  const closeBlast = () => {
    setBlastOpen(false)
  }

  /** Leave the BLAST drawer and jump elsewhere (close it first). */
  const goFromBlast = (nextView: View, id?: string) => {
    setBlastOpen(false)
    goTo(nextView, id)
  }

  /**
   * Drawer CTA: close the drawer and open this BLAST run inside the shared
   * keyword-search result views — the table form, or the map scoped to the
   * hit enzymes. ``payload`` is only echoed here (never applied) because the
   * drawer keeps drawing its own hit list; the shared session is ``blastSession``.
   */
  const enterBlastResults = (payload: BlastPayload, mode: 'table' | 'map') => {
    const session: BlastSession = { id: Date.now(), payload }
    setBlastSession(session)
    setBlastOpen(false)
    if (mode === 'map') {
      setAutoBlastScope({ sessionId: session.id, nonce: Date.now() })
      goTo('home')
    } else {
      goTo('search', undefined, { blast: true })
    }
  }

  /** Drop the BLAST session (back to plain keyword library results). */
  const exitBlastSession = () => {
    setBlastSession(null)
    setAutoBlastScope(null)
  }

  /** Table-results banner -> map: scope the home map to the active BLAST hits. */
  const openBlastMap = () => {
    if (!blastSession) return
    setAutoBlastScope({ sessionId: blastSession.id, nonce: Date.now() })
    goTo('home')
  }

  /** Map scope banner -> table: keep the session, jump to its table form. */
  const openBlastTable = () => {
    goTo('search')
  }

  const consumeBlastScope = () => {
    setAutoBlastScope(null)
  }

  /** Detail-page search box / "Data Browser": straight to the library results
   *  table, mirroring the home map's own submit behaviour. */
  const openLibrarySearch = (nextQuery: string) => {
    exitBlastSession()
    setQuery(nextQuery || '')
    setSearchKind(looksLikeProteinSequence(nextQuery || '') ? 'enzyme' : 'all')
    goTo('search', undefined, { query: nextQuery || '', blast: false })
  }

  /** The home map's search, as handed to it: `undefined` while another view is
   *  up (no signal — the resident map must keep whatever it was showing),
   *  `null` on a plain home, and the spec itself when a search is addressed. */
  const mapSearch = view === 'home' ? route.mapSearch ?? null : undefined

  /**
   * The one place a map search reaches the address bar. The map is a consumer,
   * not a second writer: it asks for a spec, this navigates, and the route comes
   * back down as `mapSearch`.
   *
   * `null`撤掉检索。撤掉时用 replace 还是 push 取决于当前在哪: 已经在首页时这是
   * 一次原地更正, 不该留一条能退回旧检索的记录; 从别的页面回来则是一次真正的
   * 导航, 用 replace 会把那条记录本身抹掉(后退就跳过它了)。
   */
  const runMapSearch = (spec: MapSearchRoute | null) => {
    if (!spec) {
      navigate({ view: 'home', mapSearch: null }, view === 'home')
      return
    }
    setMapSearchNonce((nonce) => nonce + 1)
    navigate({ view: 'home', mapSearch: spec })
  }

  /** Hand a query to the home map — the Map half of every page's Map|Table
   *  toggle, and the destination of their Pathway half.
   *
   * `mode` selects what the map should do with it: an enzyme search run on
   * arrival, or the pathway composer opened for a chain that no single keyword
   * could express. Pathway mode therefore carries an empty query without being
   * a no-op, which is why the "nothing to search for" guard only applies to the
   * enzyme half. */
  const openMapSearch = (nextQuery: string, mode: 'enzyme' | 'pathway' = 'enzyme') => {
    exitBlastSession()
    const trimmed = (nextQuery || '').trim()
    if (!trimmed && mode === 'enzyme') {
      runMapSearch(null)
      return
    }
    runMapSearch({ mode: trimmed ? 'enzyme' : 'pathway', query: trimmed, start: '', end: '', via: [] })
  }

  const clearFilters = () => {
    setQuery('')
    setSearchKind('all')
    setSelectedSpecies(filterOptions.species[0])
    setSelectedClass(filterOptions.classes[0])
    setSelectedFamily(filterOptions.families[0])
  }

  /** Brand click: land on the plain browse home map with every piece of search
   *  state — keyword query, filters, BLAST session and pending auto-scopes —
   *  dropped. The map's own compound-scope/edge selection is cleared by the
   *  map component itself (it owns that state) — but since the map stays
   *  mounted now, that no longer happens by itself on remount, so we hand it
   *  an explicit reset signal. See `mapResetNonce`. */
  const resetHome = () => {
    exitBlastSession()
    clearFilters()
    setMapResetNonce((nonce) => nonce + 1)
    goTo('home')
  }

  /**
   * Changing the search set changes what every scope/pathway result *means*, so
   * the map drops its whole search现场。URL 上那条 `?q=` 必须跟着退掉, 否则刷新
   * 会复活一次范围已经对不上的检索。
   * `replace`, not push: 换集不是一次可后悔的导航, 不该留一条能退回旧 URL 的记录。
   * (On an enzyme page `route.mapSearch` is `undefined`, so nothing happens there
   * — the map is not the surface being looked at.)
   */
  const handleSearchSetChange = (next: string[]) => {
    setSearchSet(next)
    if (route.mapSearch) navigate({ view: 'home', mapSearch: null }, true)
  }

  /**
   * The enzyme page's Back. Popping the real history entry is the whole point:
   * `goTo` pushes, which left the stack as ['/', '/enzymes/X', '/'] — pressing
   * Back put a second '/' on top and the browser's own Back then walked straight
   * into the enzyme page again. When there is nothing in-app behind us (the URL
   * was opened directly), replace instead, so no stale entry is left over.
   */
  const goHomeFromBack = () => {
    if (goBack()) return
    setSidebarOpen(false)
    navigate({ view: 'home' }, true)
  }

  // The workspace sidebar only renders on views that keep the workspace chrome,
  // which narrows `view` at the point of use — but its nav compares against
  // every destination, so it needs the unnarrowed value.
  const currentView: View = view

  return (
    <div className={`app-shell ${view === 'home' || view === 'search' ? 'home-shell' : ''}`}>
      {/* 全局导航：所有页面共用这一条，页面自己的顶栏只剩「这一页做什么」。 */}
      <GlobalNav
        view={view}
        onNavigate={(next) => goTo(next)}
        searchSet={searchSet}
        onSearchSetChange={handleSearchSetChange}
        queueCount={queueCount}
        onOpenBlast={openBlast}
        onOpenStructure={() => setStructureOpen(true)}
      />

      {/* The enzyme detail and downloads pages bring their own chrome (a
          home-style top nav, plus a module rail on the detail page), so the
          workspace sidebar/topbar stay out of their way. On the downloads page
          the topbar's "N queued" button was the worst of both: it rendered
          there but only navigated to the page it was already on. */}
      {view !== 'home' && view !== 'search' && view !== 'enzyme' && view !== 'downloads' && <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark">
            <Network size={19} strokeWidth={2.4} />
          </div>
          <div>
            <div className="brand-name">Terpene Atlas</div>
            <div className="brand-subtitle">NJU-CHINA 2026</div>
          </div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} title={t('Close navigation')}>
            <X size={17} />
          </button>
        </div>

        <div className="sidebar-section-label">{t('Workspace')}</div>
        <nav className="primary-nav">
          {navigation.map(({ view: itemView, label, icon: Icon }) => (
            <button key={itemView} className={`nav-item ${currentView === itemView ? 'active' : ''}`} onClick={() => goTo(itemView)}>
              <Icon size={18} />
              <span>{t(label)}</span>
              {itemView === 'downloads' && queueCount > 0 && <span className="nav-count accent">{queueCount}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-section-label sidebar-data-label">{t('Dataset')}</div>
        <div className="dataset-card">
          <div className="dataset-icon">
            <Database size={16} />
          </div>
          <div className="dataset-copy">
            <strong>{t('Curated terpene reference set')}</strong>
            <span>{entities.length} {t('records')} · {routeCount} {t('routes')}</span>
          </div>
          <span className="status-dot" title={t('Dataset ready')} />
        </div>
        <div className="dataset-meta">
          <span>{t('Last sync')}</span>
          <strong>2026.07.22</strong>
        </div>

        <div className="sidebar-footer">
          <button className="footer-link">
            <CircleHelp size={16} />
            {t('Data dictionary')}
          </button>
          <button className="footer-link">
            <Settings2 size={16} />
            {t('Workspace settings')}
          </button>
          <div className="version-chip">
            {entities.length} {t('entries')} · {graphNodes.length} {t('nodes')}
          </div>
        </div>
      </aside>}

      <main className="main-area">
        {view !== 'home' && view !== 'search' && view !== 'enzyme' && view !== 'downloads' && <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} title={t('Open navigation')}>
            <Menu size={20} />
          </button>
          <div className="crumbs">
            <span>Terpene Atlas</span>
            <ChevronRight size={14} />
            <strong>{t(viewLabel(view))}</strong>
          </div>
          <div className="topbar-actions">
            <div className="sync-state">
              <span className="status-dot" />
              {t('Live dataset')}
            </div>
            <button className="topbar-download" onClick={() => goTo('downloads')}>
              <Download size={16} />
              {queueCount > 0 ? `${queueCount} ${t('queued')}` : t('Queue empty')}
            </button>
          </div>
        </header>}

        {/* The map is mounted for the whole session and merely hidden off-home.
            Unmounting it used to throw away everything the user had set up —
            the pathway results they were reading, the camera, the selections —
            so coming back from an enzyme page landed on a blank map. */}
        <HomePage
          hidden={view !== 'home'}
          resetNonce={mapResetNonce}
          queueCount={queueCount}
          entityCount={entities.length}
          nodeCount={visibleNodeCount}
          edgeCount={visibleEdgeCount}
          downloadedItems={downloadedItems}
          onOpenSearch={(nextQuery) => openLibrarySearch(nextQuery || '')}
          onOpenDownloads={() => goTo('downloads')}
          onOpenEnzyme={(id) => goTo('enzyme', id)}
          onOpenBlast={openBlast}
          onOpenBlastTable={openBlastTable}
          onToggleQueue={toggleQueue}
          onQueueMany={queueEntities}
          openRecord={openRecord}
          isQueued={(id) => queuedIds.has(id)}
          mapSearch={mapSearch}
          mapSearchNonce={mapSearchNonce}
          onMapSearch={runMapSearch}
          blastSession={blastSession}
          autoBlastScope={autoBlastScope}
          onAutoBlastScopeConsumed={consumeBlastScope}
          onResetHome={resetHome}
          searchSet={searchSet}
          onSearchSetChange={handleSearchSetChange}
        />

        {view === 'enzyme' && (
          <EnzymeDetailView
            enzymeId={selectedId}
            onBack={goHomeFromBack}
            onToggleQueue={toggleQueue}
            isQueued={(id) => queuedIds.has(id)}
            queueCount={queueCount}
            onOpenDownloads={() => goTo('downloads')}
            onOpenBlast={openBlast}
            onOpenSearch={openLibrarySearch}
            onOpenMapScoped={openMapSearch}
            onOpenMap={(nextQuery) => openMapSearch(nextQuery)}
            onOpenPathwaySearch={() => openMapSearch('', 'pathway')}
            searchSet={searchSet}
            onSearchSetChange={handleSearchSetChange}
          />
        )}

        {view === 'search' && (
          <SearchResultsPage
            query={query}
            setQuery={openLibrarySearch}
            onOpenMap={(nextQuery) => openMapSearch(nextQuery)}
            onOpenPathwaySearch={() => openMapSearch('', 'pathway')}
            onOpenDownloads={() => goTo('downloads')}
            onOpenEnzyme={(id) => goTo('enzyme', id)}
            onOpenBlast={openBlast}
            onToggleQueue={toggleQueue}
            isQueued={(id) => queuedIds.has(id)}
            queueCount={queueCount}
            blastSession={route.blast ? blastSession : null}
            onExitBlast={() => {
              exitBlastSession()
              navigate({ view: 'search', query }, true)
            }}
            onOpenBlastMap={openBlastMap}
            onResetHome={resetHome}
            searchSet={searchSet}
            onSearchSetChange={handleSearchSetChange}
          />
        )}

        {view === 'downloads' && (
          <DownloadsPage
            downloadedItems={downloadedItems}
            removeFromQueue={removeFromQueue}
            clearQueue={clearQueue}
            // The queue hands back the entity it holds rather than an id to
            // re-resolve: `getEntity` reads the graph sample, which is 60
            // compound nodes and no enzymes, so every enzyme queued from the
            // search page missed the lookup and fell through to the search view.
            // Every row in that tab is an enzyme, so the destination is settled.
            onOpenEntity={(entity) => goTo('enzyme', entity.id)}
            openRecord={openRecord}
            queueCount={queueCount}
            onResetHome={resetHome}
            onOpenSearch={openLibrarySearch}
            onOpenBlast={openBlast}
            onOpenMap={(nextQuery) => openMapSearch(nextQuery)}
            onOpenPathwaySearch={() => openMapSearch('', 'pathway')}
          />
        )}
      </main>

      <BlastDrawer
        open={blastOpen}
        onClose={closeBlast}
        onOpenDownloads={() => goFromBlast('downloads')}
        onOpenEnzyme={(id) => goFromBlast('enzyme', id)}
        onToggleQueue={toggleQueue}
        isQueued={(id) => queuedIds.has(id)}
        queueCount={queueCount}
        onOpenResults={enterBlastResults}
        // BLAST 算搜索，所以搜索集对它**真的**生效（后端按搜索集另建序列库）。
        searchSet={searchSet}
      />

      {/* 结构检索抽屉：原来四个页面各开一份，现在全局一份。 */}
      <StructureSearchDrawer open={structureOpen} onClose={() => setStructureOpen(false)} />
    </div>
  )
}

function viewLabel(view: View): string {
  switch (view) {
    case 'home':
      return 'Overview'

    case 'search':
      return 'Search library'
    case 'downloads':
      return 'Download queue'
    case 'enzyme':
      return 'Enzyme detail'
    default:
      return 'Overview'
  }
}

export default App














