import { UserError } from './errors.js';
export function httpsUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new UserError('Enter a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new UserError('Only HTTPS URLs without credentials or custom ports are supported.');
  return url;
}
export function spotifyUrl(input) {
  const url = httpsUrl(input);
  const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/);
  if (url.hostname !== 'open.spotify.com' || !match) throw new UserError('Use an open.spotify.com track, album, or playlist URL with a valid ID.');
  return { type: match[1], id: match[2], url: `https://open.spotify.com/${match[1]}/${match[2]}` };
}
export function youtubeUrl(input) {
  const url = httpsUrl(input);
  let id;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  else if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})\/?$/)?.[1];
    if (url.pathname === '/playlist') {
      const list = url.searchParams.get('list');
      if (!/^[\w-]{10,100}$/.test(list ?? '')) throw new UserError('Invalid YouTube playlist ID.');
      return { type: 'playlist', url: `https://www.youtube.com/playlist?list=${list}` };
    }
  }
  if (!/^[\w-]{11}$/.test(id ?? '')) throw new UserError('Use a valid YouTube video or playlist link.');
  return { type: 'video', id, url: `https://www.youtube.com/watch?v=${id}` };
}
export function classifyInput(input) {
  let value = input?.trim();
  if (!value || value.length > 500 || /[\x00-\x1f]/.test(value)) throw new UserError('Enter 1–500 characters without control characters.');
  // Discord's suppressed-embed link syntax must retain URL routing.
  if(/^<https:\/\/[^<>]+>$/.test(value))value=value.slice(1,-1);
  if(/^(?:(?:www|m|music)\.)?youtube\.com\/|^youtu\.be\//i.test(value))value=`https://${value}`;
  const media = value.match(/^(local|stream):([a-zA-Z0-9_-]{1,80})$/);
  if (media) return { type: media[1], id: media[2] };
  if (/^https?:|^[a-z]+:\/\//i.test(value)) {
    const url = httpsUrl(value);
    if (url.hostname === 'open.spotify.com') return { source: 'spotify', ...spotifyUrl(value) };
    return { source: 'youtube', ...youtubeUrl(value) };
  }
  if (/^(?:spotify:|file:|local:|stream:)/i.test(value)) throw new UserError('Use a supported URL or a configured local:id / stream:id.');
  return { type: 'search', query: value };
}
export function integer(value, min, max, name = 'Value') {
  if (!Number.isInteger(value) || value < min || value > max) throw new UserError(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
