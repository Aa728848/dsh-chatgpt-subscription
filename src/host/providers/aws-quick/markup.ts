/**
 * Quick UI markup that only the Quick app renders.
 *
 * Quick models ask the user through inline markup the Quick renderer turns into a
 * choice card: `<decision question="…" multi="true"><option description="…">label</option></decision>`,
 * optionally grouped in `<decisions>`, and cite memories in `<sources>`. DSH renders none of it,
 * so the stream is filtered here: decisions are lifted out as structured questions
 * (later projected onto DSH `ask_user_question`) and sources are dropped. Answers go back
 * the way Quick expects them: `<decision_response>question: label</decision_response>`.
 *
 * @module dsh-chatgpt-subscription/host/aws-quick/markup
 */

export interface QuickDecisionOption{label:string;description?:string}
export interface QuickDecision{question:string;header?:string;multi:boolean;options:QuickDecisionOption[]}

const OPENERS=['<decisions>','<decision ','<decision\n','<decision\t','<sources>']
/** Held text longer than this without a closing tag is released verbatim. */
const MAX_HOLD=64*1024

function unescapeXml(text:string):string{return text.replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')}
function attributes(tag:string):Record<string,string>{const out:Record<string,string>={};for(const match of tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g))out[match[1].toLowerCase()]=unescapeXml(match[2]);return out}

/** Parse one `<decision …>…</decision>` element; null when it carries no question. */
export function parseQuickDecision(block:string):QuickDecision|null{
 const open=/^<decision\b([^>]*)>/.exec(block);if(!open)return null
 const attrs=attributes(open[1]);const question=(attrs.question??'').trim();if(!question)return null
 const options:QuickDecisionOption[]=[]
 for(const match of block.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)){const label=unescapeXml(match[2].replace(/<[^>]+>/g,'')).trim();if(!label)continue;const description=attributes(match[1]).description?.trim();options.push(description?{label,description}:{label})}
 const header=attrs.header?.trim()
 return{question,...(header?{header}:{}),multi:/^(true|1|yes)$/i.test(attrs.multi??attrs.multiple??''),options}
}

function closingIndex(buffer:string,start:number):{end:number;kind:'decisions'|'decision'|'sources'}|null{
 const head=buffer.slice(start)
 if(head.startsWith('<decisions>')){const close=head.indexOf('</decisions>');return close<0?null:{end:start+close+'</decisions>'.length,kind:'decisions'}}
 if(head.startsWith('<sources>')){const close=head.indexOf('</sources>');return close<0?null:{end:start+close+'</sources>'.length,kind:'sources'}}
 const match=/<\/decision>|<\/invoke>\s*<\/decision>/.exec(head);return match?{end:start+match.index+match[0].length,kind:'decision'}:null
}
function openerAt(buffer:string,from:number):number{let best=-1;for(const opener of OPENERS){const index=buffer.indexOf(opener,from);if(index>=0&&(best<0||index<best))best=index}return best}
function partialOpenerTail(buffer:string):number{const last=buffer.lastIndexOf('<');if(last<0)return -1;const tail=buffer.slice(last);return OPENERS.some((opener)=>opener.startsWith(tail)&&tail.length<opener.length)?last:-1}

/** Streaming filter: push text deltas, get back the text that is safe to show. */
export class QuickMarkupFilter{
 private buffer=''
 readonly decisions:QuickDecision[]=[]
 push(delta:string):string{this.buffer+=delta;return this.drain(false)}
 /** Release everything still held (an unterminated block is shown verbatim). */
 flush():string{return this.drain(true)}
 private drain(final:boolean):string{
  let out=''
  for(;;){
   const start=openerAt(this.buffer,0)
   if(start<0){const tail=final?-1:partialOpenerTail(this.buffer);if(tail<0){out+=this.buffer;this.buffer=''}else{out+=this.buffer.slice(0,tail);this.buffer=this.buffer.slice(tail)}return out}
   out+=this.buffer.slice(0,start);this.buffer=this.buffer.slice(start)
   const close=closingIndex(this.buffer,0)
   if(!close){if(final||this.buffer.length>MAX_HOLD){out+=this.buffer;this.buffer=''}return out}
   const block=this.buffer.slice(0,close.end);this.buffer=this.buffer.slice(close.end)
   if(close.kind==='decision'){const decision=parseQuickDecision(block);if(decision)this.decisions.push(decision);else out+=block}
   else if(close.kind==='decisions'){for(const match of block.matchAll(/<decision\b[^>]*>[\s\S]*?(?:<\/decision>|<\/invoke>)/g)){const decision=parseQuickDecision(match[0]);if(decision)this.decisions.push(decision)}}
  }
 }
}

/** Arguments for DSH `ask_user_question` built from Quick decisions. */
export function decisionsToAskArguments(decisions:readonly QuickDecision[]):{questions:Array<Record<string,unknown>>}{
 return{questions:decisions.map((decision,index)=>({id:'q'+(index+1),question:decision.question,...(decision.header?{header:decision.header}:{}),...(decision.options.length?{options:decision.options.map((option)=>option.description?{label:option.label,description:option.description}:{label:option.label})}:{}),...(decision.multi?{multi_select:true}:{})}))}
}

/** Plain-text fallback when the DSH session offers no question tool. */
export function renderDecisionsAsText(decisions:readonly QuickDecision[]):string{
 return decisions.map((decision)=>[`**${decision.question}**`,...decision.options.map((option,index)=>`${index+1}. ${option.label}${option.description?` — ${option.description}`:''}`)].join('\n')).join('\n\n')
}

/** Quick's native answer form for a DSH `ask_user_question` result. */
export function decisionResponseText(decisions:readonly QuickDecision[],resultText:string):string{
 let answers:Array<{id?:unknown;selected?:unknown;custom?:unknown}>|undefined
 try{const parsed=JSON.parse(resultText) as {answers?:unknown};if(Array.isArray(parsed.answers))answers=parsed.answers as typeof answers}catch{answers=undefined}
 const lines=decisions.map((decision,index)=>{
  const answer=answers?.find((item)=>item.id==='q'+(index+1))
  if(!answer)return `${decision.question}: ${answers?'':resultText.trim()}`.trimEnd()
  const selected=Array.isArray(answer.selected)?answer.selected.filter((item):item is string=>typeof item==='string'):[]
  const custom=typeof answer.custom==='string'&&answer.custom.trim()?[answer.custom.trim()]:[]
  return `${decision.question}: ${[...selected,...custom].join(', ')}`
 })
 return `<decision_response>${lines.join('\n')}</decision_response>`
}
