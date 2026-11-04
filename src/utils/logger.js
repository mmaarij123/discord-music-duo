const levels = { debug: 10, info: 20, warn: 30, error: 40 };
function redact(value) {
  return String(value).replace(/https?:\/\/\S+/gi, '[url]').replace(/[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}/g, '[token]');
}
function safeValue(value,depth=0){
  if(typeof value==='string')return redact(value);
  if(typeof value==='bigint')return String(value);
  if(value instanceof Error)return {name:value.name,code:value.code,message:redact(value.message),httpStatus:value.httpStatus,exitCode:value.exitCode,decoderReason:value.decoderReason};
  if(!value||typeof value!=='object')return value;
  if(depth>=5)return '[truncated]';
  if(Array.isArray(value))return value.slice(0,50).map(item=>safeValue(item,depth+1));
  return Object.fromEntries(Object.entries(value).filter(([key])=>!/token|secret|password|headers|url|cookie|authorization/i.test(key)).slice(0,50).map(([key,item])=>[key,safeValue(item,depth+1)]));
}
function consoleMessage(event, fields) {
  switch (event) {
    case 'ready':
      return `Bot ready · ${fields.guildCount} ${fields.guildCount === 1 ? 'server' : 'servers'} · prefix "${fields.prefix}"`;
    case 'audio_started':
      return `Now playing “${fields.trackTitle}”`;
    case 'audio_ended':
      return `Audio ended · ${Math.round(fields.playedSeconds)}s played`;
    case 'play_request_ready':
      return `${fields.queuedDuringPlayback ? 'Song added to queue' : 'Play request ready'} in ${(fields.elapsedMs / 1000).toFixed(1)}s`;
    case 'audio_retry':
      return `Reconnecting audio at ${fields.positionSeconds}s · attempt ${fields.attempt}`;
    case 'voice_removed':
      return 'Disconnected from voice';
    case 'shutdown':
      return `Stopping bot · ${fields.reason.replaceAll('_', ' ')}`;
    case 'bot_process_exited':
      return `Bot worker exited · ${fields.signal ?? `exit code ${fields.exitCode}`}`;
    default: {
      const label = event[0].toUpperCase() + event.slice(1).replaceAll('_', ' ');
      const detail = fields.error?.message ?? fields.message;
      return [label, fields.trackTitle && `“${fields.trackTitle}”`, detail].filter(Boolean).join(' · ');
    }
  }
}

export function createLogger(level = 'info', { pretty = Boolean(process.stdout.isTTY), profile } = {}) {
  return Object.fromEntries(Object.entries(levels).map(([name, rank]) => [name, (event, fields = {}) => {
    if (rank < (levels[level] ?? 20)) return;
    const safe = safeValue(fields);
    const time = new Date();
    if (pretty) {
      // The playing line already confirms a request that starts immediately.
      if (event === 'play_request_ready' && !safe.queuedDuringPlayback && level !== 'debug') return;
      const message = consoleMessage(event, safe).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');
      const label = profile ? `[${profile}] ` : '';
      process.stdout.write(`[${time.toTimeString().slice(0, 8)}] ${name.toUpperCase().padEnd(5)} ${label}${message}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ time: time.toISOString(), level: name, event, profile, ...safe })}\n`);
  }]));
}
