export class UserError extends Error {
  constructor(message, code = 'USER_ERROR') { super(message); this.name = 'UserError'; this.code = code; }
}
export function publicError(error) {
  if (error instanceof UserError) return error.message;
  if (error?.name === 'AbortError') return 'The operation was cancelled.';
  return 'The operation failed. Check the bot logs or try another permitted source.';
}
