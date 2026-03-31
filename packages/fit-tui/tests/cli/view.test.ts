import { describe, it, expect } from 'bun:test'
import { validateViewArgs, launchViewer } from '../../src/cli/view'

describe('validateViewArgs', () => {
  it('rejects missing file path', () => {
    expect(validateViewArgs(undefined, 'laps')).toMatchObject({ code: 'MISSING_ARG' })
  })

  it('rejects invalid mode', () => {
    expect(validateViewArgs('file.fit', 'bogus')).toMatchObject({ code: 'INVALID_MODE' })
  })

  it('rejects non-.fit extension', () => {
    expect(validateViewArgs('file.txt', 'laps')).toMatchObject({ code: 'INVALID_FILE' })
  })

  it('rejects path traversal', () => {
    expect(validateViewArgs('../../etc/passwd.fit', 'laps')).toMatchObject({ code: 'INVALID_FILE' })
  })

  it('accepts valid args for all modes', () => {
    expect(validateViewArgs('run.fit', 'laps')).toBeNull()
    expect(validateViewArgs('run.fit', 'raw')).toBeNull()
    expect(validateViewArgs('run.fit', 'tree')).toBeNull()
    expect(validateViewArgs('run.fit', 'protocol')).toBeNull()
  })
})

describe('launchViewer', () => {
  it('rejects non-TTY with TTY_REQUIRED error', async () => {
    await expect(launchViewer('/any/file.fit', 'laps'))
      .rejects.toMatchObject({ code: 'TTY_REQUIRED' })
  })
})
