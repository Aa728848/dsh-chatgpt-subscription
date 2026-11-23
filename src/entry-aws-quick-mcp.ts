import fs from 'node:fs/promises'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js'
const statePath=process.argv[2]
if(!statePath)throw new Error('DeepSeek Harness MCP needs its tool-state path.')
interface ToolRecord{name:string;description:string;parameters?:unknown}
const server=new Server({name:'DeepSeek Harness',version:'1.0.0'},{capabilities:{tools:{}}})
server.setRequestHandler(ListToolsRequestSchema,async()=>{
 const raw=await fs.readFile(statePath,'utf8')
 const state=JSON.parse(raw) as {tools?:ToolRecord[]}
 return{tools:(state.tools??[]).map((tool)=>({name:tool.name,description:tool.description,inputSchema:tool.parameters??{type:'object',properties:{}}}))}
})
let forwarding:Promise<void>=Promise.resolve()
server.setRequestHandler(CallToolRequestSchema,async(request)=>{
 try{
  // The broker flushes headers once it has queued this call. The body can finish independently.
  const accepted=forwarding.then(async()=>{
   const state=JSON.parse(await fs.readFile(statePath,'utf8')) as {execution?:{url?:string;token?:string}}
   const execution=state.execution
   if(!execution?.url||!execution.token)throw new Error('The DSH execution bridge is not ready.')
   return fetch(execution.url,{
    method:'POST',
    headers:{Authorization:'Bearer '+execution.token,'Content-Type':'application/json'},
    body:JSON.stringify({name:request.params.name,arguments:request.params.arguments??{}}),
    signal:AbortSignal.timeout(310_000),
   })
  })
  forwarding=accepted.then(()=>undefined,()=>undefined)
  const response=await accepted
  const result=await response.json() as {content?:unknown;isError?:boolean}
  if(!response.ok||!Array.isArray(result.content))throw new Error('The DSH execution bridge returned an invalid result.')
  return result as {content:[];isError?:boolean}
 }catch(error){return{content:[{type:'text' as const,text:'Quick could not obtain the DSH tool result: '+(error instanceof Error?error.message:String(error))}],isError:true}}
})
await server.connect(new StdioServerTransport())
