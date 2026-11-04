import { UserError } from '../utils/errors.js';
export function normalize(text = '') {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
}
const decorations = /\b(official|audio|video|lyrics?|visualizer|hd|hq|4k|music)\b/g;
function tokens(text) { return new Set(normalize(text).replace(decorations,'').split(' ').filter(Boolean)); }
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  return [...a].filter(x => b.has(x)).length / a.size;
}
const versions = [ /\bnightcore\b/, /\bslowed\b/, /\bsped up\b/, /\bcover\b/, /\bkaraoke\b/, /\binstrumental\b/, /\bremix\b/, /\blive\b/, /\bacoustic\b/ ];
export function unrequestedVersion(reference,candidate) {
  const wanted=normalize(reference.title), title=normalize(candidate.title);
  return versions.some(pattern=>pattern.test(title)&&!pattern.test(wanted));
}
export function trackIdentity(track) {
  let title=normalize(track.title).replace(decorations,'');
  const artist=normalize(track.artist);
  if(artist)title=title.replace(artist,'');
  return `${artist}|${title.replace(/\s+/g,' ').trim()}`;
}
export function cacheTrackKeys(track) {
  if (!track || ['local', 'stream'].includes(track.source)) return [];
  const keys = [];
  if (typeof track.youtubeUrl === 'string' && track.youtubeUrl) keys.push(track.youtubeUrl);
  if (typeof track.sourceUrl === 'string' && track.sourceUrl.startsWith('https://open.spotify.com/track/')) keys.push(track.sourceUrl);
  if (track.artist && track.title) keys.push(`song:${trackIdentity(track)}`);
  return keys;
}
export function scoreTrack(target, candidate) {
  const title = normalize(candidate.title), wanted = normalize(`${target.title} ${target.artist ?? ''}`);
  const haystack = `${candidate.title} ${candidate.artist ?? ''} ${candidate.channel ?? ''}`;
  const titleFit = overlap(tokens(target.title), tokens(haystack));
  const artistFit = target.artist ? overlap(tokens(target.artist), tokens(haystack)) : 1;
  let score = titleFit*65 + artistFit*20;
  let rejected = titleFit < 0.65 || (target.artist && artistFit < 0.5);
  for (const pattern of versions) if (pattern.test(title) && !pattern.test(wanted)) { score -= 65; rejected = true; }
  if (candidate.live || candidate.isLive) rejected = true;
  if (target.duration && candidate.duration) {
    const delta = Math.abs(target.duration - candidate.duration);
    score += Math.max(-25,15 - delta / Math.max(3,target.duration*0.03)*5);
    if (delta > Math.max(45,target.duration*0.25)) rejected = true;
  }
  if (/official (audio|music|video)|\btopic\b/i.test(`${candidate.title} ${candidate.channel}`)) score += 7;
  if (candidate.verified) score += 3;
  return { score, rejected, titleFit, artistFit };
}
export function bestMatch(target, candidates) {
  const ranked = candidates.map(track => ({ track, ...scoreTrack(target,track) })).filter(x => !x.rejected && x.score >= 70).sort((a,b) => b.score-a.score);
  if (!ranked.length) throw new UserError('No matching track found.','NO_MATCH');
  return ranked[0].track;
}
