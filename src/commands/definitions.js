const string = (name, extra = {}) => ({ name, type: 'string', required: true, ...extra });
const integer = (name, min = 1, max = 5000, required = true) => ({ name, type: 'integer', min, max, required });
const boolean = { name: 'enabled', type: 'boolean', required: true };
const command = (name, usage = '', args = [], extra = {}) => ({ name, usage, args, ...extra });

export const commands = [
  command('play', '<song, artist, URL, local:id or stream:id>', [string('query', { rest: true, maxLength: 500 })]),
  command('pause'),
  command('resume'),
  command('skip'),
  command('stop'),
  command('queue', '[page]', [integer('page', 1, 500, false)]),
  command('nowplaying'),
  command('volume', '<0–100>', [integer('level', 0, 100)]),
  command('loop', '<off|track|queue>', [string('mode', { choices: ['off', 'track', 'queue'] })]),
  command('shuffle'),
  command('remove', '<position>', [integer('position')]),
  command('join'),
  command('leave'),
  command('autoplay', '<on|off>', [boolean]),
  command('logchannel','[#channelname|channel mention|off]',[string('channel',{required:false,maxLength:100})]),
  command('djchannel','[#channelname|channel mention|off]',[string('channel',{required:false,maxLength:100})]),
  command('prefix','[1–2 characters]',[string('prefix',{required:false,maxLength:2})]),
  command('playlist','<create|add|save|import|play|show|remove|delete>',[],{beta:true,subcommands:[
    command('create'),command('add','<song/link>',[string('query',{rest:true,maxLength:500})]),
    command('save'),command('import','<Spotify playlist URL>',[string('url',{maxLength:500})]),
    command('play'),command('show','[page]',[integer('page',1,100,false)]),
    command('remove','<position>',[integer('position',1,1000)]),command('delete')
  ]}),
  command('clearcache','',[],{ownerOnly:true}),
  command('shutdown','',[],{ownerOnly:true}),
  command('restart','',[],{ownerOnly:true}),
  command('help')
];

export const commandMap = new Map(commands.map(command => [command.name, command]));
export function usage(command, prefix = '>') {
  return `${prefix}${command.name}${command.usage ? ` ${command.usage}` : ''}`;
}
