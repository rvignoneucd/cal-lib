import { useCallback, useEffect, useRef, useState } from 'react'
import File from 'lucide-react/dist/esm/icons/file.mjs'
import ArrowUp from 'lucide-react/dist/esm/icons/arrow-up.mjs'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import Cloud from 'lucide-react/dist/esm/icons/cloud.mjs'
import Folder from 'lucide-react/dist/esm/icons/folder.mjs'
import Search from 'lucide-react/dist/esm/icons/search.mjs'
import { apiGet } from '../../api/client'
import { isBoxDataEntry } from './boxBrowserUtils'
import './boxPickerFind.css'

function formatBoxModifiedAt(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function FolderPicker({ Tip, initialPath, onPick, onCancel }) {
  const [listing, setListing] = useState({ path: '', parent: null, entries: [] })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback((path) => {
    setLoading(true)
    setError(null)
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    apiGet(`/browse${query}`)
      .then((payload) => setListing(payload))
      .catch((err) => setError(err.message || 'Browse failed'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(initialPath || '')
  }, [load, initialPath])

  const folders = listing.entries.filter((entry) => entry.is_dir)

  return (
    <div className="picker-shell">
      <div className="picker-toolbar">
        <button
          type="button"
          className="picker-button"
          disabled={!listing.parent}
          onClick={() => listing.parent && load(listing.parent)}
        >Up</button>
        <Tip text={listing.path || ''}>
          <span className="picker-path">{listing.path || '...'}</span>
        </Tip>
      </div>
      {error && <div className="picker-error">{error}</div>}
      <div className="picker-list">
        {loading && <div className="picker-empty">Loading...</div>}
        {!loading && folders.length === 0 && <div className="picker-empty">No subfolders.</div>}
        {!loading && folders.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className="picker-row"
            onDoubleClick={() => load(entry.path)}
            onClick={() => load(entry.path)}
          >
            <Folder size={14} />
            <span>{entry.name}</span>
          </button>
        ))}
      </div>
      <div className="picker-actions">
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="primary-button"
          disabled={!listing.path}
          onClick={() => onPick(listing.path)}
        >Select this folder</button>
      </div>
    </div>
  )
}

const EMPTY_SELECTION = []

export function BoxFolderPicker({
  title = 'Pick Box Folder',
  initialFolderId = '0',
  initialSelectedIds = EMPTY_SELECTION,
  allowMultiSelect = false,
  instrumentType = null,
  onPick,
  onPickMany,
  onCancel,
}) {
  const [folderId, setFolderId] = useState(initialFolderId || '0')
  const [listing, setListing] = useState({
    id: initialFolderId || '0',
    name: 'All Files',
    parent_id: null,
    path: '/',
    modified_at: '',
    entries: [],
  })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set(initialSelectedIds || []))
  const [filter, setFilter] = useState('')
  const requestId = useRef(0)
  const cache = useRef(new Map())
  const [instrumentRules, setInstrumentRules] = useState(null)
  const [rulesError, setRulesError] = useState(null)
  // Find: search file and folder names under the current folder, then jump to
  // the folder that holds the chosen result.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findState, setFindState] = useState({ loading: false, error: null, entries: null, scope: '' })
  const [findPick, setFindPick] = useState(null)
  const [foundItem, setFoundItem] = useState(null)
  const findRequest = useRef(0)

  useEffect(() => {
    if (!instrumentType) return
    let cancelled = false
    setRulesError(null)
    apiGet('/instrument-types')
      .then((payload) => { if (!cancelled) setInstrumentRules(payload.types || []) })
      .catch(() => { if (!cancelled) setRulesError('Could not load instrument file rules. Reopen the picker to retry.') })
    return () => { cancelled = true }
  }, [instrumentType])

  const load = useCallback((nextFolderId = '0', refresh = false) => {
    const request = ++requestId.current
    const target = String(nextFolderId || '0')
    setFilter('')
    setLoading(true)
    setError(null)
    setSelectedIds(new Set())
    if (!refresh && cache.current.has(target)) {
      setListing(cache.current.get(target))
      setFolderId(target)
      setLoading(false)
      return
    }
    apiGet(`/box/browse?folder_id=${encodeURIComponent(nextFolderId || '0')}`)
      .then((payload) => {
        if (request !== requestId.current) return
        cache.current.set(target, payload)
        setListing(payload)
        setFolderId(payload?.id || nextFolderId || '0')
      })
      .catch((err) => { if (request === requestId.current) setError(err.message || 'Box browse failed') })
      .finally(() => { if (request === requestId.current) setLoading(false) })
  }, [])

  useEffect(() => {
    load(initialFolderId || '0')
    return () => { requestId.current += 1 }
  }, [initialFolderId, load])

  useEffect(() => {
    setSelectedIds(new Set(initialSelectedIds || []))
  }, [initialSelectedIds, initialFolderId])

  const runFind = () => {
    const query = findQuery.trim()
    if (!query) return
    const request = ++findRequest.current
    const scope = listing.name || 'All Files'
    setFindPick(null)
    setFindState({ loading: true, error: null, entries: null, scope })
    apiGet(`/box/search?query=${encodeURIComponent(query)}&folder_id=${encodeURIComponent(folderId || '0')}`)
      .then((payload) => {
        if (request === findRequest.current) setFindState({ loading: false, error: null, entries: payload?.entries || [], scope })
      })
      .catch((err) => {
        if (request === findRequest.current) setFindState({ loading: false, error: err.message || 'Box search failed', entries: null, scope })
      })
  }

  const goToFoundFolder = (entry) => {
    if (!entry?.parent_id) return
    setFoundItem(entry)
    setFindOpen(false)
    load(entry.parent_id)
  }

  const folders = (listing.entries || []).filter((entry) => entry.is_dir)
  const patterns = instrumentType
    ? instrumentRules?.find((rule) => rule.type === instrumentType)?.patterns || []
    : null
  const visibleEntries = (listing.entries || []).filter((entry) => isBoxDataEntry(entry, patterns) && entry.name.toLowerCase().includes(filter.toLowerCase()))
  const selectedFolder = {
    id: listing.id || folderId || '0',
    name: listing.name || 'All Files',
    path: listing.path || '/',
    uri: `box://folder/${listing.id || folderId || '0'}`,
  }
  const currentFolderModified = formatBoxModifiedAt(listing.modified_at)
  const selectedEntries = folders.filter((entry) => selectedIds.has(entry.id))

  const toggleSelected = (entryId) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
  }

  return (
    <div className="picker-shell box-picker-shell">
      <div className="picker-title-row">
        <Cloud size={15} />
        <strong>{title}</strong>
      </div>
      {rulesError && <div className="picker-error">{rulesError}</div>}
      <div className="picker-toolbar">
        <button
          type="button"
          className="picker-button"
          aria-label="Parent folder"
          title="Parent folder"
          disabled={loading || !listing.parent_id}
          onClick={() => listing.parent_id && load(listing.parent_id)}
        ><ArrowUp size={16} /></button>
        <nav className="box-picker-breadcrumbs" aria-label="Box folder path">
          {(listing.breadcrumbs || []).map((entry) => (
            <button type="button" key={entry.id} disabled={loading} onClick={() => load(entry.id)}>{entry.id === '0' ? 'All Files' : entry.name}</button>
          ))}
          <span aria-current="location">{listing.name || 'All Files'}</span>
        </nav>
        <button type="button" className={`picker-button${findOpen ? ' active' : ''}`} title="Find a file or folder by name" aria-label="Find a file or folder by name" aria-pressed={findOpen} onClick={() => setFindOpen((open) => !open)}><Search size={16} /></button>
        <button type="button" className="picker-button" title="Refresh folder" aria-label="Refresh folder" disabled={loading} onClick={() => load(folderId, true)}><RefreshCw size={16} /></button>
        {currentFolderModified && (
          <span className="picker-path-meta" title={listing.modified_at}>
            Updated {currentFolderModified}
          </span>
        )}
      </div>
      {findOpen ? (
        <form className="box-picker-find" onSubmit={(event) => { event.preventDefault(); runFind() }}>
          <input
            autoFocus
            className="box-picker-filter"
            aria-label={`Find by name in ${listing.name || 'All Files'} and its subfolders`}
            placeholder={`Find a file or folder name in ${listing.name || 'All Files'} and subfolders...`}
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
          />
          <button type="submit" className="ghost-button" disabled={!findQuery.trim() || findState.loading}>Find</button>
        </form>
      ) : (
        <input className="box-picker-filter" aria-label="Filter this folder" placeholder="Filter this folder..." value={filter} onChange={(event) => setFilter(event.target.value)} />
      )}
      {error && <div className="picker-error">{error}</div>}
      {!findOpen && foundItem && foundItem.parent_id === folderId && (
        <div className="box-picker-found" role="status">
          <span>Found <strong>{foundItem.name}</strong> in this folder.</span>
          <button type="button" className="ghost-button" onClick={() => setFoundItem(null)}>Dismiss</button>
        </div>
      )}
      {findOpen && (
        <div className="picker-list box-picker-find-results" role="listbox" aria-label="Find results">
          {findState.loading && <div className="picker-empty">Searching Box...</div>}
          {findState.error && <div className="picker-error">{findState.error}</div>}
          {!findState.loading && !findState.entries && !findState.error && (
            <div className="picker-empty">Type part of a file or folder name and press Enter. Box matches whole words and word starts; brand-new uploads can take a few minutes to appear.</div>
          )}
          {!findState.loading && findState.entries?.length === 0 && <div className="picker-empty">No matches in {findState.scope}.</div>}
          {!findState.loading && (findState.entries || []).map((entry) => (
            <button
              key={`${entry.type}:${entry.id}`}
              type="button"
              role="option"
              aria-selected={findPick?.id === entry.id}
              className={`picker-row box-picker-find-row${findPick?.id === entry.id ? ' selected' : ''}`}
              onClick={() => setFindPick(entry)}
              onDoubleClick={() => goToFoundFolder(entry)}
            >
              {entry.is_dir ? <Folder size={16} /> : <File size={16} />}
              <span className="picker-row-name">
                {entry.name}
                <small className="box-picker-find-path">{entry.path || 'All Files'}</small>
              </span>
              <span className="picker-row-meta">{formatBoxModifiedAt(entry.modified_at) || ''}</span>
            </button>
          ))}
        </div>
      )}
      <div className="picker-list" hidden={findOpen}>
        {loading && <div className="picker-empty">Loading Box folders...</div>}
        {!loading && visibleEntries.length === 0 && <div className="picker-empty">{filter ? 'No matches.' : 'This folder is empty.'}</div>}
        {!loading && visibleEntries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`picker-row${foundItem?.id === entry.id ? ' found' : ''}`}
            disabled={!entry.is_dir}
            onClick={() => entry.is_dir && load(entry.id)}
          >
            {allowMultiSelect && entry.is_dir && (
              <input
                type="checkbox"
                className="picker-row-check"
                checked={selectedIds.has(entry.id)}
                onChange={() => toggleSelected(entry.id)}
                onClick={(event) => event.stopPropagation()}
              />
            )}
            {entry.is_dir ? <Folder size={16} /> : <File size={16} />}
            <span className="picker-row-name">{entry.name}</span>
            <span className="picker-row-meta">
              {formatBoxModifiedAt(entry.modified_at) || 'No update time'}
            </span>
          </button>
        ))}
      </div>
      <div className="picker-actions">
        <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
        {allowMultiSelect && (
          <button
            type="button"
            className="ghost-button"
            disabled={loading || !selectedEntries.length}
            onClick={() => onPickMany?.({
              root: selectedFolder,
              folders: selectedEntries.map((entry) => ({
                id: entry.id,
                name: entry.name,
                path: `${listing.path || ''}/${entry.name}`.replace(/\/+/g, '/'),
                relative_path: entry.name,
                modified_at: entry.modified_at || '',
              })),
            })}
          >
            Use checked folders ({selectedEntries.length})
          </button>
        )}
        {findOpen ? (
          <button
            type="button"
            className="primary-button"
            disabled={!findPick?.parent_id}
            title={findPick ? `Open ${findPick.path || 'the folder that holds it'}` : 'Pick a result first'}
            onClick={() => goToFoundFolder(findPick)}
          >Go to folder</button>
        ) : (
          <button
            type="button"
            className="primary-button"
            disabled={loading || Boolean(error) || !selectedFolder.id}
            onClick={() => onPick(selectedFolder)}
          >Select this folder</button>
        )}
      </div>
    </div>
  )
}
