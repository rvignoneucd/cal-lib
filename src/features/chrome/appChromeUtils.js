export const THEME_MODE_STORAGE_KEY = 'atmos.themeMode.v1'

export function normalizeThemeMode(value) {
  return value === 'glass' ? 'glass' : value === 'dark' ? 'dark' : 'light'
}

export const themeBaseMode = value => value === 'dark' ? 'dark' : 'light'

export function applyThemeMode(root, body, value) {
  const theme = normalizeThemeMode(value)
  root.dataset.theme = themeBaseMode(theme)
  body.dataset.theme = themeBaseMode(theme)
  root.dataset.material = theme === 'glass' ? 'glass' : 'solid'
  root.style.colorScheme = themeBaseMode(theme)
}

export function visibleProjectOptions(projectList, currentProject, systemPrefs) {
  const base = projectList.length
    ? projectList
    : currentProject?.id
      ? [{ id: currentProject.id, name: currentProject.name, owner: currentProject.owner, is_demo: currentProject.is_demo }]
      : []
  const filtered = systemPrefs?.hide_demo_project && base.some((project) => !project.is_demo)
    ? base.filter((project) => !project.is_demo)
    : base
  return filtered.map((project) => {
    const collaborators = Array.isArray(project?.collaborators) ? project.collaborators.filter(Boolean) : []
    const accessRole = String(project?.access_role || '').trim().toLowerCase()
    let hint = ''
    if (project?.is_demo) {
      hint = 'Demo'
    } else if (accessRole && accessRole !== 'owner') {
      const owner = String(project?.owner || '').trim()
      hint = owner ? `${accessRole} - ${owner}` : accessRole
    } else if (collaborators.length) {
      hint = `${collaborators.length} collaborator${collaborators.length === 1 ? '' : 's'}`
    }
    return {
      ...project,
      hint,
    }
  })
}

export const ACTIVE_FOOTER_JOB_STATES = new Set(['queued', 'running'])

export function isFooterAtdbJob(job) {
  const name = String(job?.name || '').toLowerCase()
  return name.includes('acg/ams')
    || name.includes('.atdb')
    || name.includes('pre-process')
    || name.includes('process project files')
}

export function footerJobLabel(job) {
  const name = String(job?.name || '').toLowerCase()
  if (name.includes('acg/ams')) return 'ACG/AMS'
  if (name.includes('.atdb')) return 'ATDB'
  return 'Processing'
}
