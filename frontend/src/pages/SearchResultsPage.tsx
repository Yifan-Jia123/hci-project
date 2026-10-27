import { useEffect, useMemo, useRef, useState } from 'react'
import { isString, isStringArray, useCachedState } from '../lib/browserCache'
import { ArrowUpRight, Check, Download, Loader2, Search, X } from 'lucide-react'
import { loadMetadataFilters, searchTableEnzymes, searchTableEnzymesByIds } from '../api'
import type { BlastHit, BlastSession, TableEnzymeRow } from '../api'
import { SearchSetControl } from '../components/SearchSetControl'
import { sourceLabel, sourceOptions } from '../lib/sourceLabels'
import type { Entity } from '../types'
import { useT } from '../lib/i18n'

/**
 * Table-form search results page ("Table" half of the home Map/Table toggle).
 *
 * Reuses the home page top bar (brand + Map/Table search box) plus a
 * download-list button to its left. Below it, a filter column (data source,
 * organism, EC prefixes) only narrows the enzyme rows returned for the current
 * query; the right region lists one enzyme card per match. Each card can be
 * added to the download list.
 */


const HOME_SEARCH_PLACEHOLDER = 'Search limonene, germacrene D synthase, EC 4.2.3.75, Q9ZSY2…'

/** How many result cards are painted at once. 2000 cards ≈ 80k DOM nodes if painted
 *  synchronously — the "Show more" button below the grid walks up in these steps. */
const RESULT_PAGE = 100

/** Keyword search debounce. A common term costs ~10s server-side, so a chip click
 *  must not fire per chip — consecutive clicks collapse into one query. */
const SEARCH_DEBOUNCE_MS = 250

/** EC box debounce. Separate and longer than the above: typing `4.2.3.77` is 8
 *  keystrokes, and at `SEARCH_DEBOUNCE_MS` that would be 8 full searches. */
const EC_DEBOUNCE_MS = 400

/** Rows with no organism are shown under this label and filtered by the sentinel
 *  below, because an exact-string match on the label itself would match nothing. */
const UNKNOWN_ORGANISM_LABEL = 'Unknown organism'
const UNKNOWN_ORGANISM_SENTINEL = '__unknown__'

function organismOptionKey(row: TableEnzymeRow) {
  return row.organismName || UNKNOWN_ORGANISM_LABEL
}

function toRequestOrganism(option: string) {
  return option === UNKNOWN_ORGANISM_LABEL ? UNKNOWN_ORGANISM_SENTINEL : option
}

function countOrganisms(rows: TableEnzymeRow[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  rows.forEach((row) => {
    const name = organismOptionKey(row)
    counts.set(name, (counts.get(name) || 0) + 1)
  })
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

/** Stable dependency key for a set-valued filter: sorts and joins, so re-rendering
 *  with an equal set does not look like a change to the fetch effect. */
function listKey(values: string[]) {
  return values.length === 0 ? '' : [...values].sort().join('\0')
}

function entityField(label: string, rawValue: string | number | null | undefined) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null
  return { label, value: String(rawValue) }
}

function rowToEntity(row: TableEnzymeRow): Entity {
  const ecs = presentEcNumbers(row)
  return {
    id: row.enzymeId,
    kind: 'enzyme',
    name: row.primaryName,
    subtitle: [row.uniprotId || row.enzymeId, ecs[0]].filter(Boolean).join(' · '),
    description: ecs.length > 0 ? `Catalyses EC ${ecs.join(', ')}.` : 'Enzyme record from the terpene pathway library.',
    tags: (row.sourceTypes.length > 0 ? row.sourceTypes.map(sourceLabel) : ['Enzyme']),
    species: row.organismName || undefined,
    fields: [
      entityField('UniProt', row.uniprotId),
      entityField('Organism', row.organismName),
      entityField('Gene name', row.geneName),
      entityField('EC numbers', ecs.join(', ') || null),
      entityField('Data source', row.sourceTypes.map(sourceLabel).join(', ')),
      entityField('Reactions', row.reactionCount > 0 ? `${row.reactionCount} reaction(s)` : null),
      entityField('DeepSolNet Score', row.deepSolnetScore != null ? row.deepSolnetScore.toFixed(3) : null),
      entityField('Membrane', row.membrane ? MEMBRANE_LABELS[row.membrane] ?? row.membrane : null),
    ].filter(Boolean) as Array<{ label: string; value: string }>,
    related: [],
  }
}

/** 膜三态的显示文案。`unannotated` 不是 `non-membrane` —— 前者是没注释（占八成），
 *  后者是明确非膜；两者都受 DeepSolNet 阈值约束，只有 `membrane` 豁免。 */
const MEMBRANE_LABELS: Record<string, string> = {
  membrane: 'Membrane (score-exempt)',
  'non-membrane': 'Non-membrane',
  unannotated: 'Unannotated',
}

/** EC strings that are only placeholders ("--", "-") are not real EC numbers. */
function isEcPlaceholder(ec: string) {
  return /^-+$/.test(ec.trim())
}

function presentEcNumbers(row: TableEnzymeRow) {
  return (row.ecNumbers || []).filter((ec) => ec && !isEcPlaceholder(ec))
}

function ecGroups(ec: string): string[] {
  const value = ec.replace(/^EC\s*/i, '').trim()
  if (!value) return []
  return value.split('.').map((part) => part.trim()).filter(Boolean)
}

function prefixMatches(ec: string, prefix: string[]): boolean {
  const groups = ecGroups(ec)
  if (groups.length < prefix.length) return false
  return prefix.every((part, index) => groups[index] === part)
}

/**
 * Parse the EC filter box. Entries are separated by commas / spaces / newlines.
 * Each entry is a left-to-right EC prefix (up to 4 dot-separated digits, e.g.
 * `4.2`, `4.2.3`, `4.2.3.77`); unfilled trailing digits do not narrow results.
 * A trailing dot after the last typed digit is tolerated.
 */
function parseEcFilter(text: string): { prefixes: string[][]; invalid: string | null } {
  const prefixes: string[][] = []
  let invalid: string | null = null
  text
    .split(/[\s,，;；、]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      if (invalid) return
      if (!/^[\d.]+$/.test(token)) {
        invalid = token
        return
      }
      let groups = token.split('.')
      if (groups[groups.length - 1] === '') groups = groups.slice(0, -1)
      if (groups.length === 0 || groups.length > 4) {
        invalid = token
        return
      }
      if (!groups.every((part) => /^\d+$/.test(part))) {
        invalid = token
        return
      }
      prefixes.push(groups)
    })
  return { prefixes, invalid }
}

function rowMatchesEc(row: TableEnzymeRow, prefixes: string[][]): boolean {
  if (prefixes.length === 0) return true
  const ecs = presentEcNumbers(row)
  if (ecs.length === 0) return false
  return ecs.some((ec) => prefixes.some((prefix) => prefixMatches(ec, prefix)))
}

/** One table row rendered in this page — either a keyword hit or a BLAST hit
 *  (the latter merges the rich enzyme row with the per-subject BLAST metrics). */
export type DisplayRow = TableEnzymeRow & {
  blastHit?: {
    rank: number
    eValue: number
    identity: number
    queryCover: number
    alignmentLength: number
    bitscore: number
    subjectType: 'canonical' | 'isoform'
    isoformId?: string | null
    subjectLength: number
  }
}

function displayRowKey(row: DisplayRow) {
  return `${row.enzymeId}:${row.blastHit ? row.blastHit.rank : 'row'}`
}

function blastThresholdLabel(value: number): string {
  return value === 10 ? '10' : value.toExponential(0)
}

function formatEValue(value: number): string {
  if (value === 0) return '0'
  if (value >= 0.01) return value.toFixed(3)
  return value.toExponential(2)
}

function displayRowToEntity(row: DisplayRow): Entity {
  const base = rowToEntity(row)
  const hit = row.blastHit
  if (!hit) return base
  return {
    ...base,
    fields: [
      ...base.fields,
      entityField('BLAST identity', `${hit.identity.toFixed(1)}%`),
      entityField('BLAST E-value', formatEValue(hit.eValue)),
      entityField('BLAST query coverage', `${hit.queryCover.toFixed(1)}%`),
      entityField('BLAST bitscore', hit.bitscore.toFixed(1)),
    ].filter(Boolean) as Array<{ label: string; value: string }>,
  }
}

/** Fallback rich row built from the representative card when the by-ids fetch fails. */
function cardFallbackRow(hit: BlastHit): TableEnzymeRow {
  const card = hit.card
  return {
    enzymeId: hit.enzymeId,
    primaryName: card?.primaryName || hit.enzymeId,
    uniprotId: card?.uniprotId ?? null,
    organismName: card?.organismName ?? null,
    geneName: card?.geneName ?? null,
    ecNumbers: card?.ecNumber && !isEcPlaceholder(card.ecNumber) ? [card.ecNumber] : [],
    sourceTypes: card?.sourceType ? [card.sourceType] : [],
    reactionCount: card ? 1 : 0,
  }
}

/** Batch control under the result grid. `limit` can now be 2000, and each card is
 *  ~35–50 DOM nodes, so painting the whole page synchronously would be ~80k nodes. */
function ShowMore({ shown, visible, onMore }: { shown: number; visible: number; onMore: () => void }) {
  if (visible >= shown) return null
  return (
    <div className="search-table-more-row">
      <span>
        Showing {visible} of {shown}
      </span>
      <button type="button" onClick={onMore}>
        Show {Math.min(RESULT_PAGE, shown - visible)} more
      </button>
    </div>
  )
}

export function SearchResultsPage({
  query,
  setQuery,
  onOpenMap,
  onOpenPathwaySearch,
  onOpenDownloads,
  onOpenEnzyme,
  onOpenBlast,
  onToggleQueue,
  isQueued,
  queueCount,
  blastSession,
  onExitBlast,
  onOpenBlastMap,
  onResetHome,
  searchSet,
  onSearchSetChange,
}: {
  query: string
  setQuery: (value: string) => void
  onOpenMap: (query: string) => void
  onOpenPathwaySearch: () => void
  onOpenDownloads: () => void
  onOpenEnzyme: (enzymeId: string) => void
  onOpenBlast: () => void
  onToggleQueue: (entry: string | Entity) => void
  isQueued: (id: string) => boolean
  queueCount: number
  /** When set, this page shows the BLAST run through the keyword result views
   *  instead of the text-query table: rows arrive in E-value order and each
   *  card is annotated with the hit E-value. */
  blastSession?: BlastSession | null
  onExitBlast: () => void
  onOpenBlastMap: () => void
  /** Brand click → clear app-wide search state and land on the home map. */
  onResetHome: () => void
  /** 搜索集（检索范围，`[]` = 全部）。与下面 "Data source" 那个**显示**筛选是两层。 */
  searchSet: string[]
  onSearchSetChange: (next: string[]) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState(query)
  const [payload, setPayload] = useState<{ items: TableEnzymeRow[]; total: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runNonce, setRunNonce] = useState(0)

  const [blastRows, setBlastRows] = useState<DisplayRow[] | null>(null)
  const [blastLoading, setBlastLoading] = useState(false)
  const [blastRowsError, setBlastRowsError] = useState<string | null>(null)

  const [selectedSources, setSelectedSources] = useCachedState<string[]>('table.sources', [], isStringArray)
  /** Backend `sourceTypes` enum (empty until `/metadata/filter-options` answers). */
  const [sourceTypesFromApi, setSourceTypesFromApi] = useState<string[]>([])
  const [selectedOrganisms, setSelectedOrganisms] = useCachedState<string[]>('table.organisms', [], isStringArray)
  const [organismQuery, setOrganismQuery] = useState('')
  /** Organism options captured from a response that had **no** organism filter.
   *  Once one is selected the server only returns that organism, so deriving the
   *  options from the current rows would collapse the dropdown to a single entry
   *  and the user could not undo their own choice. */
  const [organismPool, setOrganismPool] = useState<Array<[string, number]>>([])
  const [ecText, setEcText] = useCachedState('table.ec', '', isString)
  /** `ecText` after its own (longer) debounce — only this drives the fetch. */
  const [ecCommitted, setEcCommitted] = useState(ecText)
  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE)
  const [selectedResultKey, setSelectedResultKey] = useState<string | null>(null)

  const blastMode = Boolean(blastSession)
  const blastPayload = blastSession?.payload ?? null
  const blastHitTotal = blastPayload?.hits.length ?? 0
  const previousBlastId = useRef(blastSession?.id)

  // Keep the editable box in sync when the active query changes elsewhere.
  useEffect(() => {
    setDraft(query)
  }, [query])

  // Source enum for the filter dropdown. `module=table` = full-domain organisms,
  // which this page does not use (it derives organism options from its own rows)
  // — only the source list is taken from here.
  useEffect(() => {
    let cancelled = false
    loadMetadataFilters('table')
      .then((payload) => {
        if (!cancelled) setSourceTypesFromApi(payload.sourceTypes || [])
      })
      .catch(() => {
        if (!cancelled) setSourceTypesFromApi([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Entering/leaving a BLAST session resets the client-side filters.
  useEffect(() => {
    if (previousBlastId.current === blastSession?.id) return
    previousBlastId.current = blastSession?.id
    setSelectedSources([])
    setSelectedOrganisms([])
    setOrganismQuery('')
    setEcText('')
    setEcCommitted('')
  }, [blastSession?.id])

  // The EC box commits on its own schedule — see EC_DEBOUNCE_MS.
  useEffect(() => {
    const timer = window.setTimeout(() => setEcCommitted(ecText), EC_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [ecText])

  const activeQuery = query.trim()

  // Live parse: validation feedback + the dropdown summary update as you type.
  const ecFilter = useMemo(() => parseEcFilter(ecText), [ecText])
  // Committed parse: this is what goes to the server, so a half-typed EC number
  // never becomes a request.
  const ecRequestFilter = useMemo(() => parseEcFilter(ecCommitted), [ecCommitted])
  const ecRequestPrefixes = useMemo(
    // 不合法时**一个都不发**，而不是发已解析出来的前几个 —— 发一半会让用户看到
    // 一个自己解释不了的结果集（框里同时还有红色错误说明）。
    () => (ecRequestFilter.invalid ? [] : ecRequestFilter.prefixes.map((groups) => groups.join('.'))),
    [ecRequestFilter],
  )

  // Dep keys for the set-valued filters. Using the arrays directly would make every
  // re-render look like a change (fresh array identity) and refetch for nothing.
  const sourceFilterKey = useMemo(() => listKey(selectedSources), [selectedSources])
  const organismFilterKey = useMemo(() => listKey(selectedOrganisms), [selectedOrganisms])
  const ecFilterKey = useMemo(() => ecRequestPrefixes.join(','), [ecRequestPrefixes])

  // Keyword table search — suspended while a BLAST session is being shown.
  //
  // The three toolbar filters are sent to the **server** rather than applied here.
  // `ORDER BY score DESC LIMIT n` has nothing to do with source / organism / EC, so
  // truncating first and filtering after yields "whichever of the top n happened to
  // be Swiss-Prot". Measured on `terpene synthase`: 2 rows at limit=600, 3 at 2000,
  // against 1,243 from the server-side predicate.
  useEffect(() => {
    if (blastSession) {
      setPayload(null)
      setLoading(false)
      setError(null)
      return
    }
    const q = query.trim()
    if (!q) {
      setPayload(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const timer = window.setTimeout(() => {
      searchTableEnzymes({
        q,
        sourceTypes: searchSet,
        filterSourceTypes: selectedSources,
        filterOrganismNames: selectedOrganisms.map(toRequestOrganism),
        filterEcPrefixes: ecRequestPrefixes,
        signal: controller.signal,
      })
        .then((result) => {
          if (cancelled) return
          setPayload(result)
          setVisibleCount(RESULT_PAGE)
          // Freeze the option list from a response that had no organism filter.
          if (selectedOrganisms.length === 0) setOrganismPool(countOrganisms(result.items))
        })
        .catch((err) => {
          if (cancelled) return
          setError(err instanceof Error ? err.message : 'Table search failed')
          setPayload(null)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
    // `searchSet` 必须在依赖里：换搜索集是要**重搜**的（检索范围变了），
    // 不只是把已有结果重新筛一遍。
    //
    // `*FilterKey` 是三个筛选的**序列化**形式，不是数组本身：数组每次 toggle 都是
    // 新身份，直接用会无谓重查。body 里读的是当次的 `selectedSources` /
    // `selectedOrganisms` / `ecRequestPrefixes`，与这三个 key 一一对应。
  }, [query, runNonce, blastSession, searchSet, sourceFilterKey, organismFilterKey, ecFilterKey])

  // Fetch the rich per-enzyme rows for the BLAST hits (same aggregation the
  // keyword table filters on), merged with per-hit E-value / alignment metrics.
  useEffect(() => {
    const session = blastSession
    if (!session) {
      setBlastRows(null)
      setBlastRowsError(null)
      setBlastLoading(false)
      return
    }
    let cancelled = false
    setBlastLoading(true)
    setBlastRowsError(null)
    const hits = session.payload.hits
    const ids = hits.map((hit) => hit.enzymeId)
    const mergeHits = (source: TableEnzymeRow[]): DisplayRow[] => {
      const pool = source.slice()
      return hits.map((hit, index) => {
        const poolIndex = pool.findIndex((row) => row.enzymeId === hit.enzymeId)
        const row = poolIndex >= 0 ? pool.splice(poolIndex, 1)[0] : cardFallbackRow(hit)
        return {
          ...row,
          blastHit: {
            rank: index + 1,
            eValue: hit.eValue,
            identity: hit.identity,
            queryCover: hit.queryCover,
            alignmentLength: hit.alignmentLength,
            bitscore: hit.bitscore,
            subjectType: hit.subjectType,
            isoformId: hit.isoformId,
            subjectLength: hit.subjectLength,
          },
        }
      })
    }
    searchTableEnzymesByIds(ids)
      .then((result) => {
        if (cancelled) return
        setBlastRows(mergeHits(result.items))
        setVisibleCount(RESULT_PAGE)
      })
      .catch((err) => {
        if (cancelled) return
        setBlastRowsError(err instanceof Error ? err.message : 'Could not enrich the BLAST hits.')
        setBlastRows(mergeHits([]))
      })
      .finally(() => {
        if (!cancelled) setBlastLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [blastSession])

  const baseRows = blastSession ? (blastRows ?? []) : (payload?.items ?? [])

  /**
   * Organism options. In BLAST mode they come straight from the hits (the filters
   * are client-side there, so the rows are the whole domain). In keyword mode they
   * come from `organismPool`, captured from the last response that had no organism
   * filter — see the state comment. Currently-selected names are always unioned in
   * so a selection can never vanish from the list.
   */
  const organismCounts = useMemo(() => {
    if (blastSession) return countOrganisms(blastRows ?? [])
    const counts = new Map(organismPool)
    const addIfMissing = (name: string) => {
      if (!counts.has(name)) counts.set(name, 0)
    }
    baseRows.forEach((row) => addIfMissing(organismOptionKey(row)))
    selectedOrganisms.forEach(addIfMissing)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [blastSession, blastRows, organismPool, baseRows, selectedOrganisms])

  const visibleOrganisms = useMemo(() => {
    const needle = organismQuery.trim().toLowerCase()
    if (!needle) return organismCounts
    return organismCounts.filter(([name]) => name.toLowerCase().includes(needle))
  }, [organismCounts, organismQuery])

  const anyFilterActive = selectedSources.length > 0 || selectedOrganisms.length > 0 || ecFilter.prefixes.length > 0

  /**
   * Data-source filter options. Taken from the backend's own `sourceTypes` list
   * (the only place the enum is defined) with any extra value seen in the rows
   * appended, so the filter can always reach every source that is on screen.
   * The local label map used to list only 2 of the 4 enum values.
   *
   * `baseRows` is no longer the whole domain once a source filter is applied (it is
   * now the server's reply), but that is harmless here: the API enum already covers
   * every value, so nothing drops out of the list.
   */
  const sourceFilterOptions = useMemo(() => {
    const seen = new Set<string>()
    baseRows.forEach((row) => row.sourceTypes.forEach((source) => seen.add(source)))
    return sourceOptions(sourceTypesFromApi, seen)
  }, [baseRows, sourceTypesFromApi])

  const searchSetSet = useMemo(() => new Set(searchSet), [searchSet])
  /** Selected sources the current search set cannot return — a guaranteed-empty
   *  combination. Surfaced as an explanation, never applied silently. */
  const sourcesOutsideSearchSet = useMemo(
    () => (searchSetSet.size === 0 ? [] : selectedSources.filter((source) => !searchSetSet.has(source))),
    [selectedSources, searchSetSet],
  )

  /**
   * Client-side predicate. **BLAST mode only.**
   *
   * In keyword mode the server already applied all three filters, and it is the only
   * authority — re-filtering here would silently drop more rows whenever the two
   * disagree. They can: `enzyme.organism_name` is `utf8mb4_unicode_ci` (case- and
   * accent-insensitive) while `Set.has` is exact, so a row the server counts as a
   * match can fail the check here and the count would come out lower than the rows
   * actually returned, with no visible reason.
   *
   * The BLAST path goes through `/search/table/by-ids`, which takes ids only and
   * carries no filters, so there the predicate is still needed.
   */
  const filteredItems = useMemo(() => {
    const sourceSet = new Set(selectedSources)
    const organismSet = new Set(selectedOrganisms)
    return baseRows.filter((row) => {
      if (selectedSources.length > 0 && !row.sourceTypes.some((source) => sourceSet.has(source))) return false
      if (selectedOrganisms.length > 0 && !(row.organismName && organismSet.has(row.organismName))) return false
      if (!rowMatchesEc(row, ecFilter.prefixes)) return false
      return true
    })
  }, [baseRows, selectedSources, selectedOrganisms, ecFilter.prefixes])

  const displayedRows: DisplayRow[] = blastSession ? filteredItems : (payload?.items ?? [])
  const shownCount = displayedRows.length
  const renderedRows = useMemo(
    () => displayedRows.slice(0, visibleCount),
    [displayedRows, visibleCount],
  )

  useEffect(() => {
    if (!selectedResultKey) return
    const selectionVisible = displayedRows.some((row) => displayRowKey(row) === selectedResultKey)
    if (!selectionVisible) setSelectedResultKey(null)
  }, [displayedRows, selectedResultKey])

  const resetFilters = () => {
    setSelectedSources([])
    setSelectedOrganisms([])
    setOrganismQuery('')
    setEcText('')
    setEcCommitted('')
  }

  const submitSearch = (text: string) => {
    const trimmed = text.trim()
    setDraft(trimmed)
    if (trimmed === activeQuery) {
      // Same query → a new result set is not coming; keep the filters.
      setRunNonce((nonce) => nonce + 1)
    } else {
      // A new query is a new result set, so the filters go with the old one.
      //
      // This has to happen **in the handler**, not in `useEffect(..., [query])`:
      // an effect's setState lands in the *next* commit, so the fetch effect in
      // this commit would first fire a full (~10s) request with the new query and
      // the old filters, and only then the corrected one. A handler's setState is
      // batched into this same commit — one request.
      resetFilters()
      setQuery(trimmed)
    }
  }

  /** Search-box submit: leaving the BLAST session falls back to keyword mode. */
  const submitKeywordSearch = (text: string) => {
    if (blastSession) {
      onExitBlast()
      submitSearch(text)
      return
    }
    submitSearch(text)
  }

  const toggleOrganism = (organism: string) => {
    setSelectedOrganisms((current) => (current.includes(organism) ? current.filter((item) => item !== organism) : [...current, organism]))
  }

  const goToMap = () => {
    if (blastSession) {
      onOpenBlastMap()
      return
    }
    onOpenMap(draft.trim() || activeQuery)
  }

  const hasQuery = activeQuery.length > 0

  // One result card, shared by the keyword and BLAST branches. A BLAST row adds
  // its E-value (and rank / isoform / alignment stats) so the hit is traceable.
  const renderRowCard = (row: DisplayRow) => {
    const queued = isQueued(row.enzymeId)
    const ecs = presentEcNumbers(row)
    const hit = row.blastHit
    const resultKey = displayRowKey(row)
    const selected = selectedResultKey === resultKey
    return (
      <article
        key={resultKey}
        className={`search-table-card ${hit ? 'has-blast-hit' : ''} ${selected ? 'selected' : ''}`}
        onClick={() => setSelectedResultKey(resultKey)}
        aria-current={selected ? 'true' : undefined}
      >
        <div className="search-table-card-head">
          <div className="search-table-card-titles">
            <h3>{row.primaryName}</h3>
            <p>{row.organismName || 'Unknown organism'}</p>
          </div>
          <button
            type="button"
            className={`search-table-card-check ${queued ? 'checked' : ''}`}
            onClick={() => onToggleQueue(queued ? row.enzymeId : displayRowToEntity(row))}
            title={queued ? 'Remove from download list' : 'Add to download list'}
          >
            {queued ? <Check size={18} /> : <Download size={18} />}
          </button>
        </div>

        {hit && (
          <div className="blast-table-hit">
            <span className="blast-table-rank">#{hit.rank}</span>
            <span className={`blast-subject-tag ${hit.subjectType}`}>
              {hit.subjectType === 'isoform' ? `isoform ${hit.isoformId} · ${hit.subjectLength} aa` : 'canonical'}
            </span>
            <span className="blast-table-evalue" title={t("BLAST E-value")}>E-value {formatEValue(hit.eValue)}</span>
            <span className="blast-table-align">
              {hit.identity.toFixed(1)}% identity · {hit.queryCover.toFixed(0)}% query cover · score {hit.bitscore.toFixed(1)}
            </span>
          </div>
        )}

        <div className="search-table-card-id">
          <div>
            <small>{t("UniProt entry")}</small>
            <strong>{row.uniprotId || row.enzymeId}</strong>
          </div>
          {row.geneName ? (
            <div>
              <small>Gene</small>
              <strong>{row.geneName}</strong>
            </div>
          ) : null}
        </div>

        <div className="search-table-ec-panel">
          <div className="search-table-ec-caption">{t("Catalyses (EC)")}</div>
          {ecs.length > 0 ? (
            <div className="search-table-ec-chips">
              {ecs.map((ec) => (
                <span key={ec} className="search-table-ec-chip">{ec}</span>
              ))}
            </div>
          ) : (
            <span className="search-table-ec-na">{t("Not annotated")}</span>
          )}
        </div>

        <div className="search-table-card-foot">
          <span className="search-table-card-meta">
            {row.sourceTypes.length > 0 && row.sourceTypes.map((source) => <span key={source} className={`search-table-source-tag ${source}`}>{sourceLabel(source)}</span>)}
            {row.reactionCount > 0 && <span className="search-table-reaction-count">{row.reactionCount} reaction{row.reactionCount === 1 ? '' : 's'}</span>}
            {row.deepSolnetScore != null && (
              <span className="search-table-reaction-count" title={t("DeepSolNet model reference score — not a solubility label")}>
                DeepSolNet Score {row.deepSolnetScore.toFixed(3)}{row.membrane === 'membrane' ? ' · membrane' : ''}
              </span>
            )}
          </span>
          <button type="button" className="search-table-open-link" onClick={() => onOpenEnzyme(row.enzymeId)}>
            Open detail <ArrowUpRight size={13} />
          </button>
        </div>
      </article>
    )
  }

  return (
    <div className="home-map-page search-table-page">
      <section className="search-table-stage">
        <header className="graph-top-nav search-table-topnav page-toolbar">
          <div className="search-table-search-slot">
            <button className="download-list-button" type="button" onClick={onOpenDownloads} title={t("Open download list")}>
              <Download size={15} />
              <span>{t("Downloading table")}</span>
              {queueCount > 0 && <span className="download-list-badge">{queueCount}</span>}
            </button>

            <div className="home-search-bar search-table-search-bar">
              <div className="home-mode-toggle" role="group" aria-label={t("Search mode")}>
                <button type="button" className="is-active" aria-current="page" title={t("Search compounds and enzymes by keyword / BLAST")}>{t("Enzyme")}</button>
                <button type="button" onClick={onOpenPathwaySearch} title={t("Find compound chains from a start through optional waypoints to an end")}>{t("Pathway")}</button>
              </div>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitKeywordSearch(draft)
                }}
                placeholder={HOME_SEARCH_PLACEHOLDER}
                aria-label={t("Search the enzyme library")}
              />
              <div className="home-result-toggle" role="group" aria-label={t("Search result view")}>
                <button type="button" onClick={goToMap} title={t("Show these results on the map")}>{t("Map")}</button>
                <button type="button" className="is-active" aria-current="page">{t("Table")}</button>
              </div>
              <button className="home-search-submit" type="button" onClick={() => submitKeywordSearch(draft)} title={t("Search")}>
                <Search size={18} />
              </button>
            </div>
          </div>
        </header>

        <div className="search-table-body">
          <section className="search-table-filter" aria-label={t("Table result filters")}>
            <details className="search-table-filter-dropdown">
              <summary>
                <span>{t("Data source")}</span>
                <small>{selectedSources.length === 0 ? 'All' : `${selectedSources.length} selected`}</small>
              </summary>
              <div className="search-table-filter-popover">
              <div className="search-table-source-row">
                {sourceFilterOptions.map((value) => {
                  const label = sourceLabel(value)
                  const active = selectedSources.includes(value)
                  // Prevent a combination that cannot return anything: with a search
                  // set in force, a source outside it intersects to zero rows. An
                  // already-active chip stays clickable so it can be removed.
                  const disabled = !active && searchSetSet.size > 0 && !searchSetSet.has(value)
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={disabled}
                      className={`search-table-chip ${active ? 'on' : ''}`}
                      onClick={() => setSelectedSources((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]))}
                      title={disabled
                        ? `Not in the current search set (${searchSet.map(sourceLabel).join(', ')})`
                        : active ? `Remove ${label}` : `Filter by ${label}`}
                    >
                      {label}
                      <small>{value === 'trembl' ? 'unreviewed' : 'reviewed'}</small>
                    </button>
                  )
                })}
              </div>
              {sourcesOutsideSearchSet.length > 0 && (
                // Reachable by changing the search set after picking a source. Say why
                // the list is empty and offer the fix — do not silently edit a filter
                // the user set on a different control.
                <p className="search-table-filter-conflict">
                  <span>
                    Data source filter ({sourcesOutsideSearchSet.map(sourceLabel).join(', ')}) is outside the
                    current search set ({searchSet.map(sourceLabel).join(', ')}) — no rows can match.
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedSources((current) => current.filter((source) => searchSetSet.has(source)))}
                  >
                    {t("Clear source filter")}
                  </button>
                </p>
              )}
              </div>
            </details>

            <details className="search-table-filter-dropdown">
              <summary>
                <span>{t("Organism")}</span>
                <small>{selectedOrganisms.length === 0 ? 'All' : `${selectedOrganisms.length} selected`}</small>
              </summary>
              <div className="search-table-filter-popover">
              <div className="search-table-org-search">
                <Search size={13} />
                <input value={organismQuery} onChange={(event) => setOrganismQuery(event.target.value)} placeholder={t("Search organisms…")} />
                {organismQuery && (
                  <button type="button" onClick={() => setOrganismQuery('')} title={t("Clear organism search")}>
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="search-table-org-list">
                {visibleOrganisms.length > 0 ? (
                  visibleOrganisms.map(([organism, count]) => {
                    const checked = selectedOrganisms.includes(organism)
                    return (
                      <button key={organism} type="button" className={`search-table-org-item ${checked ? 'is-checked' : ''}`} onClick={() => toggleOrganism(organism)} title={checked ? `Remove ${organism}` : `Filter by ${organism}`}>
                        <span className={`search-table-check ${checked ? 'checked' : ''}`}>{checked && <Check size={11} />}</span>
                        <span className="search-table-org-name">{organism}</span>
                        <span className="search-table-org-count">{count}</span>
                      </button>
                    )
                  })
                ) : (
                  <div className="search-table-filter-empty">No organisms in the current results.</div>
                )}
              </div>
              </div>
            </details>

            <details className="search-table-filter-dropdown search-table-ec-group">
              <summary>
                <span>{t("EC number")}</span>
                <small>{ecFilter.prefixes.length === 0 ? 'Any' : ecFilter.prefixes.join(', ')}</small>
              </summary>
              <div className="search-table-filter-popover">
              <input
                className={`search-table-ec-input ${ecFilter.invalid ? 'invalid' : ''}`}
                value={ecText}
                onChange={(event) => setEcText(event.target.value)}
                placeholder={t("e.g. 4.2.3, 1.14.13.100")}
                aria-label={t("EC number prefix filter")}
              />
              <p className="search-table-ec-hint">Enter one or more 4-part EC numbers. Fill digits left to right; empty trailing positions do not filter.</p>
              {ecFilter.invalid && <p className="search-table-ec-error">“{ecFilter.invalid}” is not a valid EC prefix (digits and dots only, up to 4 digits).</p>}
              </div>
            </details>

            <button className="search-table-reset" type="button" onClick={resetFilters} disabled={!anyFilterActive}>
              <X size={13} />
              {t("Reset filters")}
            </button>
          </section>

          <div className="search-table-main">
            {blastMode ? (
              <>
                {blastPayload && (
                  <div className="blast-results-context">
                    <div className="blast-results-context-copy">
                      <span className="blast-results-context-kicker">{t("Sequence search · BLASTp")}</span>
                      <strong>BLAST results — {blastHitTotal} hit{blastHitTotal === 1 ? '' : 's'} from a {blastPayload.queryLength} aa query</strong>
                      <span>threshold E-value ≤ {blastThresholdLabel(blastPayload.threshold)} · {blastPayload.searchedSubjects} subjects searched · ranked by E-value · same table and filters as a keyword search.</span>
                    </div>
                    <div className="blast-results-context-actions">
                      <button className="blast-results-context-map" type="button" onClick={onOpenBlastMap} title={t("Show the hit enzymes as a scope subgraph on the map")}>
                        View on map <ArrowUpRight size={14} />
                      </button>
                      <button className="blast-results-context-exit" type="button" onClick={onExitBlast} title={t("Back to plain keyword library results")}>
                        <X size={13} />
                        {t("Exit BLAST results")}
                      </button>
                    </div>
                  </div>
                )}

                {blastRowsError && (
                  <div className="search-table-feedback blast-enrich-note">
                    <X size={15} />
                    {blastRowsError} Showing per-hit cards.
                  </div>
                )}

                <div className="search-table-summary">
                  <div className="search-table-summary-query">
                    <span>{t("BLAST hits")}</span>
                  </div>
                  <div className="search-table-result-count">
                    {blastLoading && blastRows === null ? (
                      <>
                        <Loader2 size={14} className="spin" />
                        Enriching…
                      </>
                    ) : (
                      <>
                        <strong>{shownCount}</strong>
                        {blastHitTotal > 0 && shownCount < blastHitTotal ? ` of ${blastHitTotal}` : ''} hit{shownCount === 1 ? '' : 's'}
                      </>
                    )}
                  </div>
                </div>

                {blastLoading && blastRows === null && (
                  <div className="search-table-feedback">
                    <Loader2 size={18} className="spin" />
                    Enriching BLAST hits with reaction rows…
                  </div>
                )}

                {blastRows && blastRows.length === 0 && (
                  <div className="search-table-no-results">
                    <h3>{t("No BLAST hits")}</h3>
                    <p>{t("The alignment returned no significant hits above the chosen threshold.")}</p>
                  </div>
                )}

                {blastRows && blastRows.length > 0 && shownCount === 0 && (
                  <div className="search-table-no-results">
                    <h3>{t("No enzymes match the current filters")}</h3>
                    <button type="button" onClick={resetFilters}>{t("Reset filters")}</button>
                  </div>
                )}

                {shownCount > 0 && (
                  <>
                    <div className="search-table-card-grid">
                      {renderedRows.map(renderRowCard)}
                    </div>
                    <ShowMore
                      shown={shownCount}
                      visible={renderedRows.length}
                      onMore={() => setVisibleCount((count) => count + RESULT_PAGE)}
                    />
                  </>
                )}
              </>
            ) : !hasQuery ? (
              <div className="search-table-empty-state">
                <div className="search-table-empty-icon">
                  <Search size={26} />
                </div>
                <h2>{t("Search the enzyme library")}</h2>
                <p>Type a compound name, enzyme name, UniProt entry or EC number above and press Enter to list the matching enzymes as table cards.</p>
              </div>
            ) : (
              <>
                <div className="search-table-summary">
                  <div className="search-table-summary-query">
                    <span>{t("Results for")}</span>
                    <strong>“{activeQuery}”</strong>
                  </div>
                  <div className="search-table-result-count">
                    {loading && (
                      <>
                        <Loader2 size={14} className="spin" />
                        Searching…
                      </>
                    )}
                    {/* `total` is the server's true hit count (COUNT(*) OVER (), i.e.
                        computed before LIMIT) — NOT the number of rows on this page.
                        Saying "2000 of 55712" is the honest reading: the page is
                        showing a slice of that many matches.
                        The `of` clause compares against `total` (same dimension),
                        never against a client-side filtered count. */}
                    <strong>{shownCount}</strong>
                    {payload && payload.total > shownCount ? ` of ${payload.total}` : ''} enzyme
                    result{shownCount === 1 ? '' : 's'}
                  </div>
                </div>

                {loading && !payload && (
                  <div className="search-table-feedback">
                    <Loader2 size={18} className="spin" />
                    Searching the enzyme library…
                  </div>
                )}

                {error && !loading && (
                  <div className="search-table-feedback error-state">
                    <X size={18} />
                    {error}
                  </div>
                )}

                {!loading && payload && shownCount === 0 && (
                  <div className="search-table-no-results">
                    {anyFilterActive ? (
                      // With server-side filtering a zero-row reply means the filters
                      // excluded everything. We cannot tell that apart from "the term
                      // itself matches nothing" without a second query, and "no rows
                      // match the current filters" is true either way — so say the
                      // actionable thing and offer the undo.
                      <>
                        <h3>{t("No enzymes match the current filters")}</h3>
                        <p>{t("Try removing a filter.")}</p>
                        <button type="button" onClick={resetFilters}>{t("Reset filters")}</button>
                      </>
                    ) : (
                      <>
                        <h3>{t("No matching enzymes")}</h3>
                        <p>Nothing in the database matches “{activeQuery}”. Try a compound name, enzyme name, UniProt entry or EC number.</p>
                      </>
                    )}
                  </div>
                )}

                {/* Kept on screen while a new search runs (`.is-stale` dims and
                    disables it) — blanking the column for ~10s on every chip click
                    was the worst part of this page. */}
                {shownCount > 0 && (
                  <>
                    <div className={`search-table-card-grid ${loading ? 'is-stale' : ''}`}>
                      {renderedRows.map(renderRowCard)}
                    </div>
                    <ShowMore
                      shown={shownCount}
                      visible={renderedRows.length}
                      onMore={() => setVisibleCount((count) => count + RESULT_PAGE)}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </section>

    </div>
  )
}
