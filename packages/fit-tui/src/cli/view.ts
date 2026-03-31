const VALID_MODES = ['laps', 'raw', 'tree', 'protocol'] as const
export type ViewMode = (typeof VALID_MODES)[number]

// Dynamic imports — the TUI .tsx files have OpenTUI/React type issues that
// don't affect runtime. Using import() keeps them out of tsc's scope.
async function getRenderer(mode: ViewMode): Promise<(filePath: string) => Promise<void>> {
  try {
    switch (mode) {
      case 'laps':     return (await import("../tui/viewer.tsx")).renderViewer
      case 'raw':      return (await import("../tui/raw.tsx")).renderRaw
      case 'tree':     return (await import("../tui/tree.tsx")).renderTree
      case 'protocol': return (await import("../tui/protocol.tsx")).renderProtocol
    }
  } catch {
    const err = new Error("view command requires Bun runtime (@opentui is not available on Node.js)") as any
    err.code = "BUN_REQUIRED"
    throw err
  }
}

interface ViewError {
  code: string
  message: string
}

export function validateViewArgs(
  filePath: string | undefined,
  mode: string,
): ViewError | null {
  if (!filePath) {
    return { code: 'MISSING_ARG', message: 'view requires a file path' }
  }
  if (!VALID_MODES.includes(mode as ViewMode)) {
    return { code: 'INVALID_MODE', message: `invalid mode '${mode}' — must be one of: ${VALID_MODES.join(', ')}` }
  }
  if (/\.\.[/\\]/.test(filePath)) {
    return { code: 'INVALID_FILE', message: 'path traversal detected' }
  }
  if (!filePath.toLowerCase().endsWith('.fit')) {
    return { code: 'INVALID_FILE', message: 'file must have a .fit extension' }
  }
  return null
}

export async function launchViewer(filePath: string, mode: string): Promise<void> {
  if (!process.stdout.isTTY) {
    const err = new Error('view command requires a TTY (interactive terminal)') as any
    err.code = 'TTY_REQUIRED'
    throw err
  }

  const validationError = validateViewArgs(filePath, mode)
  if (validationError) {
    const err = new Error(validationError.message) as any
    err.code = validationError.code
    throw err
  }

  const render = await getRenderer(mode as ViewMode)
  await render(filePath)
}
