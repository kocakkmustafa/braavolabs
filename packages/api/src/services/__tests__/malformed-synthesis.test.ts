import {beforeEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const mocked=vi.hoisted(()=>({links:vi.fn(),run:vi.fn()}));
vi.mock('../../lib/logger',()=>({logger:{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('../provider-chain',()=>({listTenantProviderLinks:mocked.links}));
vi.mock('../../modules/agent/claude',()=>({runAgentLoop:mocked.run}));
import {parseSynthesisReply,compareAcrossModels} from '../multi-model';
const recorded=JSON.parse(readFileSync(join(__dirname,'fixtures/recorded-synthesis-nil.json'),'utf8')).reply as string;
const good={synthesis:'Comparison',consensus:['Agreement'],disagreements:[],finalAnswer:'Merged answer'};
const goodFence='```json\n'+JSON.stringify(good)+'\n```';
const arrayFence='```json\n'+JSON.stringify([good])+'\n```';
beforeEach(()=>{
 vi.clearAllMocks();mocked.links.mockResolvedValue([{provider:'OLLAMA',config:{provider:'OLLAMA',model:'gemma3:1b',apiKey:''}}]);
 mocked.run.mockImplementation(async config=>({finalContent:config.aiConfigOverride?'Paid candidate answer':recorded,provider:config.aiConfigOverride?'OLLAMA':'CUSTOM',model:'gemma3:1b',totalCostUsd:config.aiConfigOverride?0.07:0.03,totalInputTokens:5,totalOutputTokens:3}));
});
describe('recorded malformed structured synthesis',()=>{
 it('rejects the exact recorded nil JSON-like reply without manufacturing empty disagreement success',()=>{
  expect(recorded).toContain('"disagreements": nil');
  expect(parseSynthesisReply(recorded)).toMatchObject({parsed:false,status:'invalid_structured',synthesis:'',finalAnswer:'',consensus:[],disagreements:[],error:expect.stringContaining('malformed JSON')});
 });
 it.each([
  {label:'missing finalAnswer',reply:JSON.stringify({synthesis:'s',consensus:[],disagreements:[]})},
  {label:'null disagreements',reply:JSON.stringify({...good,disagreements:null})},
  {label:'mixed consensus',reply:JSON.stringify({...good,consensus:['true claim',7]})},
  {label:'string disagreements',reply:JSON.stringify({...good,disagreements:'none'})},
  {label:'empty finalAnswer',reply:JSON.stringify({...good,finalAnswer:'   '})},
  {label:'wrong synthesis type',reply:JSON.stringify({...good,synthesis:[]})},
  {label:'array root',reply:JSON.stringify([good])},
  {label:'fenced nil',reply:'```json\n'+recorded+'\n```'},
  {label:'wrapped nil',reply:'Here is the result:\n'+recorded},
  {label:'truncated wrapped synthesis',reply:'Here is the result:\n{"synthesis": nil'},
  {label:'unrelated root object',reply:'{"code": 200}'},
  {label:'unrelated fenced object',reply:'```json\n{"code": 200}\n```'},
  {label:'generic fenced wrong schema',reply:'```\n{"code": 200}\n```'},
  {label:'fenced array root',reply:'```json\n'+JSON.stringify([good])+'\n```'},
  {label:'fenced numeric scalar',reply:'```json\n42\n```'},
  {label:'fenced null scalar',reply:'```json\nnull\n```'},
  {label:'exact fenced array followed by Done.',reply:arrayFence+'\nDone.'},
  {label:'fenced array with leading prose',reply:'Here is the result:\n'+arrayFence},
  {label:'fenced array with leading and trailing prose',reply:'Here is the result:\n'+arrayFence+'\nDone.'},
  {label:'generic fenced array with surrounding prose',reply:'Here is the result:\n```\n'+JSON.stringify([good])+'\n```\nDone.'},
  {label:'array containing unrelated and synthesis objects',reply:'Here is the result:\n```json\n'+JSON.stringify([{code:200},good])+'\n```\nDone.'},
  {label:'array fence then object fence',reply:arrayFence+'\n'+goodFence},
  {label:'object fence then array fence',reply:goodFence+'\n'+arrayFence},
  {label:'multiple object fences with surrounding prose',reply:'Here is the result:\n'+goodFence+'\n'+goodFence+'\nDone.'},
  {label:'object fence plus unterminated second fence',reply:goodFence+'\n```json\n'+JSON.stringify([good])},
  {label:'unterminated array fence with leading prose',reply:'Here is the result:\n```json\n'+JSON.stringify([good])},
  {label:'exact unfenced array with leading prose and footer',reply:'Here is the result:\n'+JSON.stringify([good])+'\nDone.'},
  {label:'unfenced root array with footer',reply:JSON.stringify([good])+'\nDone.'},
  {label:'unfenced array with leading prose',reply:'Here is the result:\n'+JSON.stringify([good])},
  {label:'nested unfenced array with surrounding prose',reply:'Here is the result:\n'+JSON.stringify([[good]])+'\nDone.'},
  {label:'outer object wrapping a complete synthesis',reply:'Here is the result:\n'+JSON.stringify({result:good})+'\nDone.'},
  {label:'outer array wrapping a complete synthesis',reply:'Here is the result:\n'+JSON.stringify([{result:good}])+'\nDone.'},
  {label:'unclosed outer array with complete nested object',reply:'Here is the result:\n['+JSON.stringify(good)+'\nDone.'},
  {label:'mismatched outer array closing brace',reply:'Here is the result:\n['+JSON.stringify(good)+'}\nDone.'},
  {label:'unclosed outer object with complete nested object',reply:'Here is the result:\n{"result":'+JSON.stringify(good)+'\nDone.'},
  {label:'mismatched nested container',reply:'Here is the result:\n[{"result":'+JSON.stringify(good)+']\nDone.'},
  {label:'structured object plus unmatched closing bracket',reply:'Here is the result:\n'+JSON.stringify(good)+']\nDone.'},
  {label:'multiple unfenced synthesis objects',reply:'Here is the result:\n'+JSON.stringify(good)+'\n'+JSON.stringify(good)+'\nDone.'},
 ])('rejects $label',({reply})=>expect(parseSynthesisReply(reply)).toMatchObject({parsed:false,status:'invalid_structured',finalAnswer:''}));
 it.each([JSON.stringify(good),goodFence,'Here is the result:\n'+JSON.stringify(good),'Here is the result:\n'+goodFence,goodFence+'\nDone.','Here is the result:\n'+goodFence+'\nDone.'])('retains full valid structured output',reply=>expect(parseSynthesisReply(reply)).toEqual({...good,parsed:true,status:'structured'}));
 it('treats markdown inside a valid root answer string as data',()=>{
  const answer={...good,finalAnswer:'The API example is ```json {"code": 200}```.'};
  expect(parseSynthesisReply(JSON.stringify(answer))).toEqual({...answer,parsed:true,status:'structured'});
 });
 it('treats markdown inside a valid fenced answer string as data through surrounding prose',()=>{
  const answer={...good,finalAnswer:'The API example is ```json {"code": 200}```.'};
  expect(parseSynthesisReply('Here is the result:\n```json\n'+JSON.stringify(answer)+'\n```\nDone.')).toEqual({...answer,parsed:true,status:'structured'});
 });
 it.each([
  'Models broadly agree on 42.','The answer uses the notation {x, y}.','42','[1] Models agree on the answer.',
  'The API example is {"code": 200}.',
  '[1] The API example is {"code": 200}.',
  'The metadata example is {"metadata": {"synthesis": "example"}}.',
  'The API example is {"code": 200',
  'An API example:\n```json\n{"code": 200}\n```',
  'An API array example:\n```json\n[{"code": 200}]\n```\nDone.',
  'Two API examples:\n```json\n{"code": 200}\n```\n```json\n{"code": 201}\n```',
  'An API array example is [{"code": 200}].',
  '[1] The API array example is [{"code": 200}].',
  'A nested metadata array example is [{"metadata": {"synthesis": "example"}}].',
  'Two API examples are {"code": 200} and {"code": 201}.',
  'The API example contains delimiters: {"code": 200, "text": "[ ] { }"}.',
  '"A plain answer"','true','null',
 ])('preserves ordinary plain text explicitly: %s',reply=>expect(parseSynthesisReply(reply)).toEqual({synthesis:reply,finalAnswer:reply,consensus:[],disagreements:[],parsed:false,status:'plain_text'}));
 it.each([
  'Here is the result:\n'+JSON.stringify({...good,finalAnswer:'Quoted delimiters: [ ] { } and an escaped "quote".'})+'\nDone.',
  '[1] Here is the result:\n'+JSON.stringify(good)+'\nDone.',
  'An API example {"code": 200}. Here is the result:\n'+JSON.stringify(good)+'\nDone.',
 ])('retains one intended outer object through prose and unrelated containers',reply=>{
  const result=parseSynthesisReply(reply);expect(result).toMatchObject({synthesis:good.synthesis,consensus:good.consensus,disagreements:good.disagreements,parsed:true,status:'structured'});
  expect(result.finalAnswer).toBe(reply.includes('Quoted delimiters:')?'Quoted delimiters: [ ] { } and an escaped "quote".':good.finalAnswer);
 });
 it('retains paid candidate and synthesizer costs but does not promote malformed text to answer',async()=>{
  const result=await compareAcrossModels('synthetic-tenant','Synthetic task');
  expect(result.synthesisStatus).toBe('invalid_structured');expect(result.synthesisParsed).toBe(false);
  expect(result.finalAnswer).toBe('Paid candidate answer');expect(result.synthesis).toBe('');expect(result.synthesizerError).toContain('Invalid structured synthesis');
  expect(result.perModel[0].answer).toBe('Paid candidate answer');expect(result.synthesizer).toMatchObject({provider:'CUSTOM',model:'gemma3:1b',costUsd:0.03});expect(result.totalCostUsd).toBeCloseTo(0.1,10);
 });
 it('retains intentional plain-text compare and its real cost',async()=>{
  mocked.run.mockResolvedValueOnce({finalContent:'Candidate',totalCostUsd:0.07,totalInputTokens:1,totalOutputTokens:1}).mockResolvedValueOnce({finalContent:'Ordinary prose answer',totalCostUsd:0.03,totalInputTokens:1,totalOutputTokens:1});
  const result=await compareAcrossModels('synthetic-tenant','Synthetic task');expect(result.synthesisStatus).toBe('plain_text');expect(result.finalAnswer).toBe('Ordinary prose answer');expect(result.totalCostUsd).toBeCloseTo(0.1,10);
 });
 it('budget skip remains explicit candidate-only degradation',async()=>{
  const result=await compareAcrossModels('synthetic-tenant','Synthetic task',{maxCostUsd:0.07});
  expect(result.synthesisStatus).toBe('budget_skipped');expect(result.budgetExceeded).toBe(true);expect(result.finalAnswer).toBe('Paid candidate answer');expect(mocked.run).toHaveBeenCalledTimes(1);
 });
 it('provider call failure retains the existing candidate-only contract',async()=>{
  mocked.run.mockResolvedValueOnce({finalContent:'Paid candidate answer',totalCostUsd:0.07,totalInputTokens:1,totalOutputTokens:1}).mockRejectedValueOnce(new Error('Synthetic provider failure'));
  const result=await compareAcrossModels('synthetic-tenant','Synthetic task');expect(result.synthesisStatus).toBe('unavailable');expect(result.finalAnswer).toBe('Paid candidate answer');expect(result.synthesizer).toBeNull();expect(result.totalCostUsd).toBeCloseTo(0.07,10);
 });

});
