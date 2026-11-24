import type { ContentBlock, Message } from '../../common/llm-compat.ts'
import { imageBlockToInline, type ResolvedRequestImages } from '../../common/request-images.ts'
import { LlmError } from '../../common/llm-compat.ts'

export interface QuickImageAttachment { type:'image';name:string;size:number;mimeType:string;data:string }
export type QuickResultContent = {type:'text';text:string}|{type:'image';data:string;mimeType:string}

function record(block:ContentBlock):Record<string,unknown>{return block as unknown as Record<string,unknown>}
function quickImageName(block:ContentBlock):string{
 const value=record(block);const attachment=value.attachment&&typeof value.attachment==='object'?value.attachment as Record<string,unknown>:undefined
 return (typeof attachment?.name==='string'&&attachment.name)||(typeof value.name==='string'&&value.name)||'attached image'
}
export function quickImageLabel(block:ContentBlock):string{return '[Image: '+quickImageName(block)+']'}
function inline(block:ContentBlock,images:ResolvedRequestImages){
 const value=record(block);const loaded=imageBlockToInline(value,images)
 if(!loaded)throw new LlmError('AWS Quick could not read '+quickImageLabel(block)+'; attach the image again.','INVALID_REQUEST')
 return loaded
}
export function quickImageAttachments(messages:Message[],images:ResolvedRequestImages):QuickImageAttachment[]{
 const out:QuickImageAttachment[]=[]
 for(const message of messages)for(const block of message.content){if(block.type!=='image')continue;const loaded=inline(block,images);out.push({type:'image',name:quickImageName(block),size:Buffer.byteLength(loaded.data,'base64'),mimeType:loaded.mediaType,data:'data:'+loaded.mediaType+';base64,'+loaded.data})}
 return out
}
export function quickToolResultContent(blocks:ContentBlock[],images:ResolvedRequestImages):QuickResultContent[]{
 const out:QuickResultContent[]=[]
 for(const block of blocks){if(block.type==='text'){out.push({type:'text',text:block.text});continue}if(block.type==='image'){const loaded=inline(block,images);out.push({type:'image',data:loaded.data,mimeType:loaded.mediaType});continue}throw new LlmError('AWS Quick cannot project tool result block '+String(record(block).type??'unknown')+'.','INVALID_REQUEST')}
 return out
}
