/** Offline regression: actual loopback HTTP/JWT/router/service/compare/parser;
 * database, limiter storage and inference mocked. No provider or Redis calls. */
import{beforeAll,afterAll,beforeEach,it,expect,vi}from'vitest';
import express from'express';import http from'node:http';import type{AddressInfo}from'node:net';import jwt from'jsonwebtoken';
import{readFileSync}from'node:fs';import{join}from'node:path';
const m=vi.hoisted(()=>({member:vi.fn(),company:vi.fn(),links:vi.fn(),create:vi.fn(),update:vi.fn(),find:vi.fn(),findUnique:vi.fn(),run:vi.fn(),incr:vi.fn(),expire:vi.fn(),row:{}as any}));
vi.mock('../../../config/env',()=>({env:{JWT_SECRET:'malformed-synthesis-synthetic-secret-at-least-32',ENCRYPTION_KEY:'malformed-synthesis-synthetic-encryption-at-least-32',AUTH_COOKIE_MODE:false,OFFLINE_MODE:false,NODE_ENV:'test'}}));
vi.mock('../../../lib/db',()=>({prisma:{user:{findFirst:m.member},company:{findFirst:m.company},webResearchSession:{create:m.create,update:m.update,findFirst:m.find,findUnique:m.findUnique}}}));
vi.mock('../../../lib/redis',()=>({redis:{incr:m.incr,expire:m.expire}}));
vi.mock('../../../lib/logger',()=>({logger:{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('../../../services/provider-chain',()=>({listTenantProviderLinks:m.links}));
vi.mock('../../agent/claude',()=>({runAgentLoop:m.run}));vi.mock('../cascade.service',()=>({runTenantCascade:vi.fn()}));
import{researchRouter}from'../research.router';import{errorHandler}from'../../../middleware/error';import{currentTenantContext}from'../../../lib/tenant-context';
import{startResearch}from'../research.service';
const reply=JSON.parse(readFileSync(join(__dirname,'../../../services/__tests__/fixtures/recorded-synthesis-nil.json'),'utf8')).reply as string;
const tenant='malformed-synthetic-tenant';let server:http.Server;let base:string;
beforeAll(async()=>{const app=express();app.use(express.json());app.use('/api/v1/research',researchRouter);app.use(errorHandler);server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address()as AddressInfo).port}`;});
afterAll(()=>new Promise<void>(r=>server?.listening?server.close(()=>r()):r()));
beforeEach(()=>{
 vi.clearAllMocks();m.row={};m.member.mockImplementation(async({where})=>{expect(currentTenantContext()).toEqual({kind:'tenant',tenantId:tenant});return where.tenantId===tenant?{id:'synthetic-user',tenantId:tenant,role:'OWNER'}:null;});m.company.mockResolvedValue({id:'synthetic-company',tenantId:tenant});
 m.links.mockResolvedValue([{provider:'OLLAMA',config:{provider:'OLLAMA',model:'gemma3:1b',apiKey:''}}]);
 m.create.mockImplementation(async({data})=>{m.row={id:'synthetic-session',...data};return m.row;});m.update.mockImplementation(async({data})=>{Object.assign(m.row,data);return m.row;});m.find.mockImplementation(async({where})=>where.tenantId===tenant?{...m.row,sources:[]}:null);
 m.findUnique.mockImplementation(async()=>m.row);
 m.incr.mockResolvedValue(1);m.expire.mockResolvedValue(1);
 m.run.mockImplementation(async config=>({finalContent:config.aiConfigOverride?'Paid candidate answer':reply,provider:config.aiConfigOverride?'OLLAMA':'CUSTOM',model:'gemma3:1b',totalCostUsd:config.aiConfigOverride?0.07:0.03,totalInputTokens:5,totalOutputTokens:3}));
});
async function start(){
 const token=jwt.sign({userId:'synthetic-user',tenantId:tenant,role:'OWNER'},'malformed-synthesis-synthetic-secret-at-least-32',{expiresIn:'10m'});
 const response=await fetch(base+'/api/v1/research/compare/selected',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({companyId:'synthetic-company',query:'Synthetic compare question',selections:[{provider:'OLLAMA',model:'gemma3:1b'}]})});
 expect(response.status).toBe(201);return token;
}
it('recorded malformed JSON becomes FAILED with partial candidates and actual cost, never completed raw JSON',async()=>{
 const token=await start();await vi.waitFor(()=>expect(m.row.status).toBe('FAILED'));
 expect(m.update.mock.calls.some(([arg])=>arg.data.status==='COMPLETED')).toBe(false);expect(m.row.error).toContain('Invalid structured synthesis');expect(m.row.costUsd).toBeCloseTo(0.1,10);
 expect(m.row.findings.summary).toBe('Paid candidate answer');expect(m.row.findings.summary).not.toContain('disagreements');expect(m.row.findings.multiModel).toMatchObject({synthesisStatus:'invalid_structured',synthesisParsed:false,synthesis:'',finalAnswer:'Paid candidate answer'});
 expect(m.row.findings.multiModel.perModel[0].answer).toBe('Paid candidate answer');expect(m.run).toHaveBeenCalledTimes(2);
 const response=await fetch(base+'/api/v1/research/synthetic-session',{headers:{Authorization:`Bearer ${token}`}});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'FAILED',error:expect.stringContaining('Invalid structured synthesis'),findings:{summary:'Paid candidate answer'}});
});
it.each([
 {label:'fenced synthesis array followed by Done.',reply:'```json\n'+JSON.stringify([{synthesis:'s',consensus:[],disagreements:[],finalAnswer:'Merged answer'}])+'\n```\nDone.'},
 {label:'fenced synthesis array with surrounding prose',reply:'Here is the result:\n```json\n'+JSON.stringify([{synthesis:'s',consensus:[],disagreements:[],finalAnswer:'Merged answer'}])+'\n```\nDone.'},
 {label:'multiple synthesis fences',reply:'```json\n'+JSON.stringify({synthesis:'s',consensus:[],disagreements:[],finalAnswer:'Merged answer'})+'\n```\n```json\n'+JSON.stringify([{synthesis:'s',consensus:[],disagreements:[],finalAnswer:'Merged answer'}])+'\n```'},
 {label:'exact unfenced synthesis array with surrounding prose',reply:'Here is the result:\n'+JSON.stringify([{synthesis:'s',consensus:[],disagreements:[],finalAnswer:'Merged answer'}])+'\nDone.'},
 {label:'unclosed array containing a complete synthesis',reply:'Here is the result:\n['+JSON.stringify({synthesis:'s',consensus:[],disagreements:[],finalAnswer:'Merged answer'})+'\nDone.'},
 {label:'mismatched array containing a complete synthesis',reply:'Here is the result:\n['+JSON.stringify({synthesis:'s',consensus:[],disagreements:[],finalAnswer:'Merged answer'})+'}\nDone.'},
])('$label is FAILED with partial candidates and full cost',async example=>{
 m.run.mockImplementation(async config=>({finalContent:config.aiConfigOverride?'Paid candidate answer':example.reply,provider:config.aiConfigOverride?'OLLAMA':'CUSTOM',model:'gemma3:1b',totalCostUsd:config.aiConfigOverride?0.07:0.03,totalInputTokens:5,totalOutputTokens:3}));
 const token=await start();await vi.waitFor(()=>expect(m.row.status).toBe('FAILED'));
 expect(m.update.mock.calls.some(([arg])=>arg.data.status==='COMPLETED')).toBe(false);expect(m.row.error).toContain('Invalid structured synthesis');expect(m.row.costUsd).toBeCloseTo(0.1,10);
 expect(m.row.findings.summary).toBe('Paid candidate answer');expect(m.row.findings.multiModel).toMatchObject({synthesisStatus:'invalid_structured',synthesisParsed:false,synthesis:'',finalAnswer:'Paid candidate answer'});
 expect(m.row.findings.multiModel.perModel[0].answer).toBe('Paid candidate answer');expect(m.run).toHaveBeenCalledTimes(2);
 const response=await fetch(base+'/api/v1/research/synthetic-session',{headers:{Authorization:`Bearer ${token}`}});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'FAILED',findings:{summary:'Paid candidate answer'}});
});
it.each([{label:'plain text',reply:'Ordinary plain-text synthesis',status:'plain_text'},{label:'numeric plain text',reply:'42',status:'plain_text'},{label:'citation-led plain text',reply:'[1] Models agree on the answer.',status:'plain_text'},{label:'prose with unrelated embedded JSON',reply:'The API example is {"code": 200}.',status:'plain_text'},{label:'prose with nested synthesis-like metadata',reply:'The metadata example is {"metadata": {"synthesis": "example"}}.',status:'plain_text'},{label:'valid structured',reply:JSON.stringify({synthesis:'s',consensus:[],disagreements:[],finalAnswer:'Merged answer'}),status:'structured'}])('preserves $label completion explicitly',async example=>{
 m.run.mockImplementation(async config=>({finalContent:config.aiConfigOverride?'Candidate':example.reply,totalCostUsd:0.01,totalInputTokens:1,totalOutputTokens:1}));
 await start();await vi.waitFor(()=>expect(m.row.status).toBe('COMPLETED'));expect(m.row.error).toBeUndefined();expect(m.row.findings.multiModel.synthesisStatus).toBe(example.status);expect(m.row.findings.multiModel.synthesisParsed).toBe(example.status==='structured');
 expect(m.row.findings.summary).toBe(example.status==='structured'?'Merged answer':example.reply);expect(m.row.costUsd).toBeCloseTo(0.02,10);
});
it.each([true,false])('malformed optional augmentation preserves base findings and completion (distill done=%s)',async done=>{
 const previousProvider=process.env.WEB_RESEARCH_PROVIDER;const previousKey=process.env.TAVILY_API_KEY;
 const baseFindings={summary:'Valid base research answer',claims:[{claim:'Base claim',citations:[]}]};
 process.env.WEB_RESEARCH_PROVIDER='tavily';process.env.TAVILY_API_KEY='synthetic-search-key';
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({results:[]})}));
 m.run.mockImplementation(async config=>{
  if(config.aiConfigOverride)return{finalContent:'Paid candidate answer',totalCostUsd:0.07};
  if(config.systemPrompt.startsWith('You are a synthesis judge.'))return{finalContent:reply,totalCostUsd:0.03};
  if(config.systemPrompt.startsWith('You are a research analyst.'))return{finalContent:JSON.stringify(done?{done:true,findings:baseFindings}:{done:false,followUps:[]}),totalCostUsd:0.02};
  return{finalContent:JSON.stringify(baseFindings),totalCostUsd:0.01};
 });
 try{
  await startResearch({tenantId:tenant,companyId:'synthetic-company',query:'Synthetic research question',maxRounds:1,multiModel:true});
  await vi.waitFor(()=>expect(m.row.status).toBe('COMPLETED'));
  expect(m.row.error).toBeUndefined();expect(m.row.findings).toMatchObject(baseFindings);
  expect(m.row.findings.multiModel).toMatchObject({synthesisStatus:'invalid_structured',finalAnswer:'Paid candidate answer',synthesis:'',synthesizerError:expect.stringContaining('Invalid structured synthesis')});
  expect(m.row.costUsd).toBeCloseTo(done?0.12:0.13,10);expect(m.run).toHaveBeenCalledTimes(done?3:4);
  expect(fetch).toHaveBeenCalledTimes(1);
 }finally{
  vi.unstubAllGlobals();if(previousProvider===undefined)delete process.env.WEB_RESEARCH_PROVIDER;else process.env.WEB_RESEARCH_PROVIDER=previousProvider;
  if(previousKey===undefined)delete process.env.TAVILY_API_KEY;else process.env.TAVILY_API_KEY=previousKey;
 }
});
