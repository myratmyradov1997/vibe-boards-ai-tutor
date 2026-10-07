import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createEngine } from './engine.mjs';
import { createProvider,loadCredentials } from './provider.mjs';
import { createJevProvider } from './jev-provider.mjs';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.ino':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8','.zip':'application/zip','.mp4':'video/mp4'};
export function createTutorServer({curriculum,respond,staticRoot,port=4340,now=Date.now,maxSessions=80,rateLimit=12,publicOrigin=null,apiOnly=false}){
 if(publicOrigin && (new URL(publicOrigin).origin!==publicOrigin||!publicOrigin.startsWith('https://')))throw Error('Expected canonical HTTPS origin');
 const root=apiOnly?null:fs.realpathSync(staticRoot),sessions=new Map();let active=0;const creationTimes=[];

 const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(body));};
 function getSession(req){const id=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('vb_tutor='))?.slice(9);const s=sessions.get(id);return s&&s.expires>now()?s:null;}
 async function readBody(req){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>12000)throw Error('Body too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 const server=http.createServer(async(req,res)=>{
  try{
   const actualPort=port||server.address()?.port;
   const hosts=new Set(publicOrigin?[new URL(publicOrigin).host]:[`127.0.0.1:${actualPort}`,`localhost:${actualPort}`]);
   if(!hosts.has(req.headers.host))return json(res,403,{error:'Недопустимый адрес локального сервера.'});
   const url=new URL(req.url,'http://'+req.headers.host);
    if(url.pathname.startsWith('/api/tutor/')){
     const isAllowedOrigin=(orig)=>{
      if(publicOrigin)return orig===publicOrigin;
      if(!orig)return true;
      return new Set(['http://'+req.headers.host,'http://localhost:4321','http://127.0.0.1:4321','http://localhost:4340','http://127.0.0.1:4340']).has(orig);
     };
     const origin=req.headers.origin;
     if(origin&&!isAllowedOrigin(origin))return json(res,403,{error:'Запрос с другого сайта запрещён.'});
     if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Запрос с другого сайта запрещён.'});
     if(url.pathname==='/api/tutor/health'&&req.method==='GET')return json(res,200,{ok:true});
     for(const [id,s] of sessions)if(s.expires<=now()&&!s.busy)sessions.delete(id);
     if(url.pathname==='/api/tutor/session'&&req.method==='GET'){
      const lessonId=url.searchParams.get('lesson');const lesson=Object.hasOwn(curriculum,lessonId)?curriculum[lessonId]:null;if(!lesson)return json(res,404,{error:'Урок не найден.'});
      let session=getSession(req);
      if(!session){while(creationTimes.length&&creationTimes[0]<now()-3600000)creationTimes.shift();if(sessions.size>=maxSessions||creationTimes.length>=100)return json(res,429,{error:'Слишком много учебных сессий. Попробуй позже.'});
       const id=randomBytes(24).toString('hex');session={csrf:randomBytes(24).toString('hex'),expires:now()+3600000,history:new Map(),requests:[],busy:false};sessions.set(id,session);creationTimes.push(now());
       res.setHeader('Set-Cookie',`vb_tutor=${id}; HttpOnly; SameSite=Strict; Path=/api/tutor/; Max-Age=3600${publicOrigin?'; Secure':''}`);
      }
      return json(res,200,{csrf:session.csrf,title:lesson.title,lessonId:lesson.id,exercises:lesson.exercises.map(({id,title,task})=>({id,title,task})),history:session.history.get(lesson.id)||[],maxLength:2000});
     }
     if(url.pathname==='/api/tutor/chat'&&req.method==='POST'){
      if(!isAllowedOrigin(origin)||!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{error:'Запрос отклонён.'});
     const session=getSession(req);if(!session||req.headers['x-tutor-csrf']!==session.csrf)return json(res,403,{error:'Обнови страницу, чтобы продолжить разговор.'});
     let body;try{body=await readBody(req);}catch{return json(res,400,{error:'Не удалось прочитать вопрос.'});}
     if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['lessonId','exerciseId','message'].includes(k))||typeof body.message!=='string'||!body.message.trim()||body.message.length>2000||typeof body.lessonId!=='string'||!Object.hasOwn(curriculum,body.lessonId))return json(res,400,{error:'Проверь вопрос и выбранный урок.'});
     const lesson=curriculum[body.lessonId];if(body.exerciseId!==null&&body.exerciseId!==undefined&&!lesson.exercises.some(e=>e.id===body.exerciseId))return json(res,400,{error:'Задание не найдено.'});
     if(/\buser_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{15,}/.test(body.message))return json(res,400,{error:'Убери ключ или токен из сообщения. Для объяснения он не нужен.'});
     session.requests=session.requests.filter(t=>t>now()-300000);if(session.requests.length>=rateLimit)return json(res,429,{error:'Сделай небольшую паузу и проверь последнюю подсказку.'});
     if(session.busy||active>=2)return json(res,429,{error:'Помощник ещё готовит ответ. Подожди немного.'});
     session.requests.push(now());session.busy=true;active++;
     try{
      const history=session.history.get(lesson.id)||[];
      const reply=await respond({lessonId:lesson.id,exerciseId:body.exerciseId||null,message:body.message.trim(),history});
      if(typeof reply.text!=='string')throw Error('Invalid reply');
      if(reply.kind!=='unavailable'&&reply.kind!=='limit')session.history.set(lesson.id,[...history,{role:'user',content:body.message.trim(),exerciseId:body.exerciseId||null},{role:'assistant',content:reply.text}]);
      return json(res,200,{text:reply.text,kind:reply.kind,reviewed:reply.approved===true});
     }finally{session.busy=false;active--;}
    }
    return json(res,404,{error:'Не найдено.'});
   }
   if(apiOnly)return json(res,404,{error:'Не найдено.'});
   if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'Метод не поддерживается.'});
   let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{return json(res,400,{error:'Некорректный адрес.'});}
   if(decoded.includes('\0')||decoded.includes('\\')||decoded.split('/').some(s=>s.startsWith('.')))return json(res,404,{error:'Не найдено.'});
   const target=path.resolve(root,'.'+decoded);if(target!==root&&!target.startsWith(root+path.sep))return json(res,404,{error:'Не найдено.'});
   let file=target;try{if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');file=fs.realpathSync(file);if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile())throw Error();}catch{return json(res,404,{error:'Не найдено.'});}
   const type=MIME[path.extname(file)];if(!type)return json(res,404,{error:'Не найдено.'});
   res.writeHead(200,{'Content-Type':type,'Content-Length':fs.statSync(file).size,'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cache-Control':'no-cache'});
   if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
  }catch{if(!res.headersSent)json(res,503,{error:'Помощник временно недоступен. Попробуй позже.'});else res.end();}
 });
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href){
 try{
  const config=loadCredentials();const privateDir=process.env.TUTOR_STATE_DIR||path.join(os.homedir(),'.config/vibe-boards-tutor');fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
  const quotaFile=path.join(privateDir,'usage.json');let usage={date:new Date().toISOString().slice(0,10),calls:0,totalTokens:0};
  if(fs.existsSync(quotaFile)){const previous=JSON.parse(fs.readFileSync(quotaFile));if(previous.date===usage.date)usage=previous;}
  const save=()=>{fs.writeFileSync(quotaFile,JSON.stringify(usage),{mode:0o600});};
  const callModel=createProvider(config,{reserveCall:()=>{const today=new Date().toISOString().slice(0,10);if(usage.date!==today)usage={date:today,calls:0,totalTokens:0};if(usage.calls>=240)throw Error('Daily limit');usage.calls++;save();},onUsage:({totalTokens})=>{usage.totalTokens+=totalTokens;save();}});
  // Jev mode is a config decision (config.jev present): gate/review go to TypeSafe decisions,
  // the draft generator and every safety property of the engine stay unchanged. Removing the
  // config.jev block restores the pure DeepSeek path without any code change.
  const wired=config.jev?createJevProvider(callModel,config):callModel;
  const curriculum=JSON.parse(fs.readFileSync(new URL('./curriculum.generated.json',import.meta.url)));
  const respond=createEngine({curriculum,callModel:wired,onAudit:e=>console.log(JSON.stringify({event:'tutor-check',...e,engine:config.jev?'jev':'deepseek'}))});
  const port=4340,publicOrigin=process.env.TUTOR_PUBLIC_ORIGIN||null;const server=createTutorServer({curriculum,respond,staticRoot:path.resolve('output/ai-tutor/site'),port,publicOrigin,apiOnly:!!publicOrigin});
  server.requestTimeout=240000;server.headersTimeout=10000;server.listen(port,'127.0.0.1',()=>console.log(`Tutor ready: ${publicOrigin||'http://127.0.0.1:'+port}/lessons/cpp-variables/`));
 }catch{console.error('Cannot start tutor. Check private credentials, build and context. No secrets logged.');process.exitCode=1;}
}
