// Exit codes of the generator CLI — part of the shared contract with the `ai scaffold` wrapper.
// INTERNAL (70, EX_SOFTWARE) is not in the contract on purpose: a crash must never look like exit 1 = drift.
export const EXIT = Object.freeze({ OK: 0, DRIFT: 1, USAGE: 2, EXISTS: 3, INCOMPATIBLE: 4, INTERNAL: 70 })

export class KitError extends Error {
  constructor(code, message, exit) {
    super(message)
    this.name = 'KitError'
    this.code = code
    this.exit = exit
  }
}

export const usageError = (message, code = 'usage') => new KitError(code, message, EXIT.USAGE)
export const existsError = (message, code = 'dir_not_empty') => new KitError(code, message, EXIT.EXISTS)
export const incompatible = (code, message) => new KitError(code, message, EXIT.INCOMPATIBLE)
