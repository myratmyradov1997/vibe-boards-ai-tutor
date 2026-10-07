import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export function loadCredentials(file=process.env.TUTOR_CONFIG_FILE||path.join(os.homedir(),'.config/vibe-boards-tutor/credentials.json')){
 const stat=fs.statSync(file);if(process.platform!=='win32'&&(stat.mode&0o077))throw Error('Credential file must have permissions 0600');
 const c=JSON.parse(fs.readFileSync(file,'utf8'));
 if(c.endpoint!=='https://api.commandcode.ai/provider/v1/chat/completions'||!c.apiKey||!c.tutorModel||!c.reviewerModel)throw Error('Invalid private provider configuration');
 return c;
}
export function createProvider(config,{reserveCall=()=>{},onUsage=()=>{},fetchImpl=fetch}={}){
 return async function callModel({role,phase='unknown',messages,json=false,maxTokens=650,timeoutMs=65000}){
  // Count the daily quota once per request; a rare retry is not charged twice.
  reserveCall();
  // Only the generator requests non-thinking mode; scope and independent review retain low.
  // Do not combine thinking=disabled with reasoning_effort, or use unsupported effort=none.
  const reasoning=role==='tutor'?{thinking:{type:'disabled'}}:{reasoning_effort:'low'};
  const body=JSON.stringify({model:role==='tutor'?config.tutorModel:config.reviewerModel,messages,stream:false,max_tokens:Math.max(maxTokens,role==='reviewer'?8192:4096),...reasoning,...(json?{response_format:{type:'json_object'}}:{})});
  // The provider intermittently answers 5xx or drops the connection. A single retry keeps the
  // child from being told "try later". A 4xx is a real configuration error, and a timeout is
  // never retried: a second wait would exceed the nginx response limit.
  const attempt=async()=>{
   const response=await fetchImpl(config.endpoint,{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json','User-Agent':'VibeBoards-Tutor/0.1'},body,signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Provider unavailable'),{code:'http_'+response.status});}
   return response.json();
  };
  let data;
  try{data=await attempt();}
  catch(error){
   const code=String(error?.code||'');
   const transient=(code.startsWith('http_5')||code==='ECONNRESET'||code==='ECONNREFUSED'||code==='EPIPE')&&error?.name!=='TimeoutError'&&error?.name!=='AbortError';
   if(!transient)throw error;
   data=await attempt();
  }
  const choice=data.choices?.[0];
  onUsage({totalTokens:Number(data.usage?.total_tokens)||0});
  // Never expose reasoning_content, raw provider errors, partial/truncated drafts or tool calls.
  if(choice?.finish_reason!=='stop'||typeof choice.message?.content!=='string'||choice.message.tool_calls?.length)throw Object.assign(new Error('Incomplete provider result'),{code:phase+'_finish_'+(choice?.finish_reason||'missing')});
  const text=choice.message.content;if(text.includes(config.apiKey))throw Error('Credential leak blocked');
  return text;
 };
}
