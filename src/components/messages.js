import { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags, MessageFlagsBitField } from 'discord.js';

export const textDisplay=content=>new TextDisplayBuilder().setContent(content);
export function componentsMessage(components){
  return {flags:MessageFlags.IsComponentsV2,components,allowedMentions:{parse:[],repliedUser:false}};
}
export function textMessage(content){return componentsMessage([new ContainerBuilder().addTextDisplayComponents(textDisplay(content))]);}
export function panelsMessage(panels,{combine=false}={}){
  if(combine){
    const container=new ContainerBuilder();
    for(const [index,panel] of panels.entries()){
      if(index)container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
      container.addTextDisplayComponents(textDisplay([panel.title,panel.description].filter(Boolean).join('\n')));
    }
    return componentsMessage([container]);
  }
  return componentsMessage(panels.map(panel=>{
    const container=new ContainerBuilder().addTextDisplayComponents(textDisplay(panel.title));
    if(panel.description)container.addTextDisplayComponents(textDisplay(panel.description));
    return container;
  }));
}
export function commandMessage(payload){
  if(!isComponentsV2(payload))return textMessage(typeof payload==='string'?payload:payload.content||'The operation failed. Try again.');
  const withoutAccent=component=>{
    const data=structuredClone(component.toJSON?.()??component);
    delete data.accent_color;
    if(data.components)data.components=data.components.map(withoutAccent);
    return data;
  };
  return componentsMessage(payload.components.map(component=>{
    const data=withoutAccent(component);
    return new ContainerBuilder(data.type===17?data:{components:[data]});
  }));
}
export function isComponentsV2(message){return new MessageFlagsBitField(message?.flags??0).has(MessageFlags.IsComponentsV2);}
export function componentsEdit(message,payload,wasV2=isComponentsV2(message)){
  // Upgrading an existing message requires clearing its legacy body. Do not
  // include those legacy fields on new V2 sends or subsequent V2 edits.
  return isComponentsV2(payload)&&!wasV2?{...payload,content:null,embeds:[],attachments:[]}:payload;
}
