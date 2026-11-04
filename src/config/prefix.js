export const validPrefix=value=>typeof value==='string'&&/^[\x21-\x7e]{1,2}$/.test(value)&&!value.includes('`');

export function guildPrefix(manager,guildId){
  return manager.settings?.getPrefix(guildId)??manager.config?.prefix??'>';
}

export function prefixPanels(panels,prefix){
  return panels.map((panel,index)=>index===0?{...panel,title:`**Your Prefix is **\`${prefix}\``}:panel);
}
