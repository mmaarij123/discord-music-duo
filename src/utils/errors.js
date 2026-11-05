export class UserError extends Error {
  constructor(message, code = 'USER_ERROR') { super(message); this.name = 'UserError'; this.code = code; }
}
export function publicError(error) {
  if (error instanceof UserError) {
    switch (error.code) {
      case 'SPOTIFY_UNAVAILABLE': return 'Couldn’t open that Spotify link. Try another link or search by song name.';
      case 'TOOL_TIMEOUT': return 'This took too long. Try again.';
      case 'VOICE_TIMEOUT': return 'Couldn’t join your voice channel. Try again.';
      case 'PLAYLIST_STORAGE': return 'Couldn’t save your playlist. Try again later.';
      case 'ACCESS_DENIED':
      case 'SOURCE_STALE':
      case 'EXTRACTOR':
      case 'FORMAT':
      case 'FFMPEG':
      case 'TOOL_MISSING':
      case 'COOKIE_CONFIG':
      case 'COOKIE_EXPIRED':
      case 'AUDIO_STREAM':
      case 'MEDIA_UNAVAILABLE':
        return 'Couldn’t play this track. Try another song or link.';
      default: return error.message;
    }
  }
  if (error?.name === 'AbortError') return 'The operation was cancelled.';
  return 'Something went wrong. Try again.';
}
