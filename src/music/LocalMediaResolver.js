import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { httpsUrl } from '../utils/validators.js';
import { UserError } from '../utils/errors.js';
export class LocalMediaResolver {
  constructor(config) { this.config = config; }
  async entry(kind,id) {
    let manifest;
    try { manifest = JSON.parse(await readFile(this.config.manifest,'utf8')); }
    catch { throw new UserError('The authorized media library is not configured. Ask the operator to create media.json.'); }
    const section = kind === 'local' ? manifest?.local : manifest?.streams;
    const entry = Object.hasOwn(section ?? {}, id) ? section[id] : undefined;
    if (typeof entry?.title!=='string'||!entry.title.trim()) throw new UserError('That media ID is not in the operator’s authorized library with a valid title.');
    const duration=Number(entry.duration);
    const track={title:entry.title.trim(),artist:typeof entry.artist==='string'&&entry.artist.trim()?entry.artist:'Authorized library',
      album:typeof entry.album==='string'?entry.album:undefined,duration:Number.isFinite(duration)&&duration>0?duration:undefined,
      artwork:typeof entry.artwork==='string'?entry.artwork:undefined,source:kind,mediaId:id};
    if (kind === 'local') {
      let root;
      try{root=await realpath(this.config.mediaRoot);}catch{throw new UserError('The configured MEDIA_ROOT folder is missing or unreadable.');}
      let input;
      try { input = await realpath(path.resolve(root,entry.file)); } catch { throw new UserError('The configured local media file is missing.'); }
      const relative = path.relative(root,input);
      if (!relative || relative==='..'||relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(input)).isFile()) throw new UserError('Local media must be a regular file within MEDIA_ROOT.');
      return { kind:'local', input, duration:track.duration,track };
    }
    const url = httpsUrl(entry.url);
    // Only an operator can add stream URLs. Users can select IDs, never URLs.
    if (entry.authorized !== true) throw new UserError('The operator must mark this stream as authorized in media.json.');
    return { kind:'remote', input:url.href, headers:{}, duration:track.duration,track };
  }
  async resolve(kind,id) {
    const source=await this.entry(kind,id);
    return { tracks:[source.track], notices:[] };
  }
}
