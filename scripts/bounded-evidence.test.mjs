import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/pack-bounded-evidence.py");
function fixture(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "braavo-evidence-")));
  const h = {root, output: join(root, "upload/evidence.tar")};
  for (const name of ["playwright-report", "test-results", "dist-release"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "playwright-report/index.html"), "<html>anonymous proof</html>");
  writeFileSync(join(root, "test-results/identity.json"), '{"source":"synthetic"}\n');
  writeFileSync(join(root, "dist-release/sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
  writeFileSync(join(root, "dist-release/SHA256SUMS"), "synthetic proof checksums\n");
  try { return fn(h); } finally { rmSync(root, { recursive:true, force:true }); }
}
function run(h, args = []) {
  return spawnSync("python3", [SCRIPT, "--kind", "playwright", "--output", h.output, ...args], {
    cwd:h.root, encoding:"utf8", timeout:10_000,
    env:{PATH:"/opt/homebrew/bin:/usr/bin:/bin", PYTHONDONTWRITEBYTECODE:"1"},
  });
}
function contents(h) {
  const result = spawnSync("python3", ["-c", `import json,tarfile,hashlib,sys
with tarfile.open(sys.argv[1]) as t:
 print(json.dumps({m.name:hashlib.sha256(t.extractfile(m).read()).hexdigest() for m in t.getmembers() if m.isfile()}))`, h.output], {encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
function hash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function rejected(h, args = []) {
  const result=run(h,args); assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,/packing rejected; original evidence retained/);
  assert.equal(readdirSync(join(h.root,"upload")).includes("evidence.tar"),false);
  assert.deepEqual(readdirSync(join(h.root,"upload")),[]);
}

test("bounded evidence preserves complete Playwright files and source hashes", () => fixture((h) => {
  const result=run(h); assert.equal(result.status,0,result.stderr);
  const receipt=JSON.parse(result.stdout); assert.equal(receipt.file_count,2);
  assert.equal(receipt.stored_artifact_limit_bytes,128*1024*1024);
  assert.equal(receipt.max_packed_bytes,127*1024*1024);
  assert.equal(receipt.sha256,hash(h.output)); assert.equal(receipt.retention_days,3);
  assert.deepEqual(contents(h),{
    "playwright-report/index.html":hash(join(h.root,"playwright-report/index.html")),
    "test-results/identity.json":hash(join(h.root,"test-results/identity.json")),
  });
  const zipped=spawnSync("python3",["-c",`import json,zipfile,sys,os
with zipfile.ZipFile(sys.argv[1]+'.zip','w',compression=zipfile.ZIP_STORED) as z:z.write(sys.argv[1],'evidence.tar')
print(json.dumps({'tar':os.stat(sys.argv[1]).st_size,'zip':os.stat(sys.argv[1]+'.zip').st_size}))`,h.output],{encoding:"utf8"});
  assert.equal(zipped.status,0,zipped.stderr);
  const sizes=JSON.parse(zipped.stdout); assert.ok(sizes.zip-sizes.tar<1024*1024);
}));
test("bounded provenance preserves SBOM and SHA256SUMS without including unrelated files", () => fixture((h) => {
  const result=run(h,["--kind","provenance"]); assert.equal(result.status,0,result.stderr);
  assert.deepEqual(Object.keys(contents(h)).sort(),["dist-release/SHA256SUMS","dist-release/sbom.cdx.json"]);
}));
test("bounded evidence accepts exact physical TAR byte boundary", () => fixture((h) => {
  const result=run(h,["--max-bytes","10240"]); assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(h.output).length,10240);
}));
test("bounded evidence rejects header/padding overflow before publishing", () => fixture((h) => {
  mkdirSync(join(h.root,"upload")); rejected(h,["--max-bytes","10239"]);
  assert.equal(readFileSync(join(h.root,"test-results/identity.json"),"utf8"),'{"source":"synthetic"}\n');
}));
test("bounded evidence rejects payload overflow without reading or truncating it", () => fixture((h) => {
  mkdirSync(join(h.root,"upload")); writeFileSync(join(h.root,"test-results/large.bin"),Buffer.alloc(20000,3));
  const before=hash(join(h.root,"test-results/large.bin"));
  rejected(h,["--max-bytes","10240"]); assert.equal(hash(join(h.root,"test-results/large.bin")),before);
}));
for (const cap of ["0","-1",String(128*1024*1024),"999999999"]) {
  test(`bounded evidence rejects raised/invalid byte cap ${cap}`,()=>fixture((h)=>{
    mkdirSync(join(h.root,"upload")); rejected(h,["--max-bytes",cap]);
  }));
}
for (const target of ["playwright-report/index.html","test-results/linked-file","test-results/linked-dir"]) {
  test(`bounded evidence rejects symlink ${target}`,()=>fixture((h)=>{
    mkdirSync(join(h.root,"upload"));
    const path=join(h.root,target); rmSync(path,{force:true});
    symlinkSync(join(h.root,"dist-release"),path);
    rejected(h);
  }));
}
test("bounded evidence rejects a linked evidence root",()=>fixture((h)=>{
  mkdirSync(join(h.root,"upload")); rmSync(join(h.root,"test-results"),{recursive:true});
  symlinkSync(join(h.root,"dist-release"),join(h.root,"test-results")); rejected(h);
}));
test("bounded evidence refuses to overwrite previously published output",()=>fixture((h)=>{
  mkdirSync(join(h.root,"upload")); writeFileSync(h.output,"retained\n");
  assert.equal(run(h).status,1); assert.equal(readFileSync(h.output,"utf8"),"retained\n");
}));
test("bounded evidence rejects output within its input tree",()=>fixture((h)=>{
  h.output=join(h.root,"test-results/evidence.tar"); assert.equal(run(h).status,1);
  assert.equal(readdirSync(join(h.root,"test-results")).includes("evidence.tar"),false);
}));
test("bounded evidence rejects linked output parent before creating directories",()=>fixture((h)=>{
  symlinkSync(join(h.root,"dist-release"),join(h.root,"upload"));
  h.output=join(h.root,"upload/should-not-exist/evidence.tar"); assert.equal(run(h).status,1);
  assert.equal(readdirSync(join(h.root,"dist-release")).includes("should-not-exist"),false);
}));
test("bounded evidence rejects empty or missing required proof",()=>fixture((h)=>{
  rmSync(join(h.root,"playwright-report/index.html")); rmSync(join(h.root,"test-results/identity.json"));
  assert.equal(run(h).status,1);
  rmSync(join(h.root,"test-results"),{recursive:true}); assert.equal(run(h).status,1);
}));
test("bounded evidence preserves Unicode and nested binary proof bytes",()=>fixture((h)=>{
  mkdirSync(join(h.root,"test-results/kanıt")); const file=join(h.root,"test-results/kanıt/trace.zip");
  writeFileSync(file,Buffer.from([0,255,23,0,40])); assert.equal(run(h).status,0);
  assert.equal(contents(h)["test-results/kanıt/trace.zip"],hash(file));
}));

test("workflow byte gates preserve full CI evidence, retention, cache and useful steps",()=>{
  const ci=readFileSync(join(ROOT,".github/workflows/ci.yml"),"utf8");
  const deploy=readFileSync(join(ROOT,".github/workflows/deploy.yml"),"utf8");
  assert.match(ci,/name: Bound Playwright evidence[\s\S]*?if: always\(\)[\s\S]*?--kind playwright/);
  assert.match(ci,/if: always\(\) && steps\.playwright-evidence\.outcome == 'success'/);
  assert.match(ci,/name: Bound release provenance[\s\S]*?--kind provenance/);
  for (const name of ["bounded-playwright","bounded-provenance"]) {
    assert.match(ci,new RegExp(`path: \\$\\{\\{ runner.temp \\}\\}/${name}/evidence[.]tar\\n          compression-level: 0\\n          if-no-files-found: error\\n          retention-days: 3`));
  }
  assert.match(ci,/Release contract regressions[\s\S]*?scripts\/bounded-evidence\.test\.mjs/);
  assert.match(deploy,/\^sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(deploy,/compression-level: 0\n          if-no-files-found: error\n          retention-days: 1/);
  assert.doesNotMatch(ci+deploy,/overwrite: true/);
});


test("bounded evidence rejects special input files without blocking",()=>fixture((h)=>{
  const result=spawnSync("mkfifo",[join(h.root,"test-results/pipe")]); assert.equal(result.status,0);
  assert.equal(run(h).status,1);
}));
function importPack(h, scenario) {
  return spawnSync("python3",["-c",`import importlib.util,pathlib,os,json,sys
spec=importlib.util.spec_from_file_location('bounded',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
base=pathlib.Path.cwd();out=base/'upload'/'evidence.tar';out.parent.mkdir();outside=base/'outside';outside.mkdir()
${scenario}
try:
 m.pack('playwright',out,m.PACKED_LIMIT)
except (m.EvidenceError,OSError):
 print(json.dumps({'rejected':True,'outside_files':[p.name for p in outside.iterdir()],'published':out.exists(),'retained_files':list((base/'retained-upload').iterdir()) if (base/'retained-upload').exists() else []},default=str))
else:
 print(json.dumps({'rejected':False,'outside_files':[p.name for p in outside.iterdir()],'published':out.exists()}))
`,SCRIPT],{cwd:h.root,encoding:"utf8",timeout:10_000,env:{PATH:"/opt/homebrew/bin:/usr/bin:/bin",PYTHONDONTWRITEBYTECODE:"1"}});
}
for (const replacement of ["symlink", "directory"]) {
  test(`bounded evidence rejects output parent replaced by ${replacement} during packing`,()=>fixture((h)=>{
    const scenario=`original=m.open_regular
changed=False
def swap(*args):
 global changed
 if not changed:
  changed=True;(base/'upload').rename(base/'retained-upload')
  ${replacement === "symlink" ? "(base/'upload').symlink_to(outside,target_is_directory=True)" : "(base/'upload').mkdir()"}
 return original(*args)
m.open_regular=swap`;
    const result=importPack(h,scenario);assert.equal(result.status,0,result.stderr);
    const proof=JSON.parse(result.stdout);assert.equal(proof.rejected,true);
    assert.equal(proof.published,false);assert.deepEqual(proof.outside_files,[]);
    assert.deepEqual(proof.retained_files,[]);
  }));
}
for (const name of ["file bytes", "membership"]) {
  test(`bounded evidence rejects changed input ${name} during packing`,()=>fixture((h)=>{
    const action=name === "file bytes" ? "p=base/'test-results/identity.json';p.write_text('changed proof')" : "(base/'test-results/new.json').write_text('new proof')";
    const result=importPack(h,`original=m.open_regular
changed=False
def mutate(*args):
 global changed
 if not changed:
  changed=True;${action}
 return original(*args)
m.open_regular=mutate`);
    assert.equal(result.status,0,result.stderr); const proof=JSON.parse(result.stdout);
    assert.equal(proof.rejected,true);assert.equal(proof.published,false);
  }));
}


test("bounded evidence rejects temp leaf swapped to an oversized symlink at publication",()=>fixture((h)=>{
  const result=importPack(h,`original=m.os.link
(outside/'oversize.bin').write_bytes(b'x'*20000)
def swap(src,dst,**kwargs):
 os.unlink(src,dir_fd=kwargs['src_dir_fd'])
 os.symlink(outside/'oversize.bin',src,dir_fd=kwargs['src_dir_fd'])
 return original(src,dst,**kwargs)
m.os.link=swap`);
  assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout);
  assert.equal(proof.rejected,true);assert.equal(proof.published,false);
  assert.equal(readFileSync(join(h.root,"outside/oversize.bin")).length,20000);
}));
for (const replacement of ["symlink","FIFO"]) {
  test(`bounded evidence never reopens replaced temp ${replacement} for hashing`,()=>fixture((h)=>{
    const result=importPack(h,`original=m.inventory
calls=0
def mutate(*args):
 global calls
 calls+=1
 if calls==2:
  name=next((base/'upload').glob('.packing-*'));name.unlink()
  ${replacement === "symlink" ? "name.symlink_to(outside/'unused')" : "os.mkfifo(name)"}
 return original(*args)
m.inventory=mutate`);
    assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout);
    assert.equal(proof.rejected,true);assert.equal(proof.published,false);
  }));
}
test("bounded evidence rejects packed bytes changed after initial receipt hashing",()=>fixture((h)=>{
  const result=importPack(h,`original=m.bounded_digest
calls=0
def mutate(stream,limit):
 global calls
 calls+=1
 proof=original(stream,limit)
 if calls==1:
  stream.seek(600);stream.write(b'changed packed bytes');stream.flush()
 return proof
m.bounded_digest=mutate`);
  assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout);
  assert.equal(proof.rejected,true);assert.equal(proof.published,false);
}));
