import { commandMap, usage } from './definitions.js';
import { UserError } from '../utils/errors.js';

export function parsePrefix(content, prefix = '>') {
  if (typeof content !== 'string' || !content.startsWith(prefix)) return null;
  const body = content.slice(prefix.length).trim();
  if (!body) return null;
  const head = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  const name = head[1].toLowerCase();
  const command = commandMap.get(name);
  if (!command) throw new UserError(`Unknown music command. Use ${prefix}help.`);
  let selected=command;
  const fail = message => { throw new UserError(`${message} Usage: ${usage(selected, prefix)}`); };
  let remainder = head[2]?.trim() ?? '';
  const values = {};
  if(command.subcommands){
    const sub=/^(\S+)(?:\s+([\s\S]*))?$/.exec(remainder),action=sub?.[1]?.toLowerCase();
    const definition=command.subcommands.find(item=>item.name===action);
    if(!definition)fail('Choose a valid playlist action.');
    selected={...definition,name:`${name} ${action}`};values.action=action;remainder=sub?.[2]?.trim()??'';
  }
  for (const argument of selected.args) {
    let raw;
    if (argument.rest) { raw = remainder; remainder = ''; }
    else {
      const next = /^(\S+)(?:\s+([\s\S]*))?$/.exec(remainder);
      raw = next?.[1] ?? '';
      remainder = next?.[2]?.trim() ?? '';
    }
    if (!raw) {
      if (argument.required) fail(`Missing ${argument.name}.`);
      continue;
    }
    if (argument.type === 'integer') {
      if (!/^-?\d+$/.test(raw)) fail(`${argument.name} must be an integer.`);
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < argument.min || value > argument.max) fail(`${argument.name} must be from ${argument.min} to ${argument.max}.`);
      values[argument.name] = value;
    } else if (argument.type === 'boolean') {
      const enabled = raw.toLowerCase();
      if (!['on', 'off', 'true', 'false'].includes(enabled)) fail(`${argument.name} must be on or off.`);
      values[argument.name] = ['on', 'true'].includes(enabled);
    } else {
      if (argument.maxLength && raw.length > argument.maxLength) fail(`${argument.name} exceeds ${argument.maxLength} characters.`);
      if (/[\x00-\x1f]/.test(raw)) fail(`${argument.name} must not contain control characters.`);
      if (argument.choices && !argument.choices.includes(raw.toLowerCase())) fail(`${argument.name} must be ${argument.choices.join(', ')}.`);
      values[argument.name] = argument.choices ? raw.toLowerCase() : raw;
    }
  }
  if (remainder) fail('Too many arguments.');
  return { commandName: name, values };
}
