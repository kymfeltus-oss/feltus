const BASE=(process.env.FELTUS_STAGING_URL||"https://staging.feltuslabs.com").replace(/\/+$/,"");
const EMAIL=process.env.FELTUS_STAGING_EMAIL||"kymfeltus@gmail.com";
const PASSWORD=process.env.FELTUS_STAGING_PASSWORD||"";
const PROJECT="FELTUS Staging QA";
const ASSET="QA Test Asset";
const MODEL="qa_items";

if(!PASSWORD){
  console.error("BLOCKED: FELTUS_STAGING_PASSWORD is not set.");
  process.exit(2);
}

let cookie="";
let project=null;
const results=[];

function out(status,name,detail=""){
  results.push({status,name,detail});
  console.log(`${status.padEnd(7)} ${name}${detail?" - "+detail:""}`);
}

async function test(name,fn,status="PASS"){
  try{
    const detail=await fn();
    out(status,name,detail||"");
  }catch(e){
    out("FAIL",name,e.message||String(e));
  }
}

function ok(value,message){
  if(!value) throw new Error(message);
}

function list(data){
  if(Array.isArray(data)) return data;
  for(const key of ["data","items","apps","assets","models","relationships","documents"]){
    if(Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

async function req(path,{method="GET",body,auth=true,origin}={}){
  const headers={};
  if(auth&&cookie) headers.cookie=cookie;
  if(origin) headers.origin=origin;

  let payload;
  if(body!==undefined){
    headers["content-type"]="application/json";
    payload=JSON.stringify(body);
  }

  const r=await fetch(BASE+path,{
    method,
    headers,
    body:["GET","HEAD"].includes(method)?undefined:payload,
    redirect:"manual"
  });

  const text=await r.text();
  let data=text;
  try{ data=text?JSON.parse(text):null; }catch{}

  return {status:r.status,headers:r.headers,data,text};
}

console.log("");
console.log("FELTUS STAGING ACCEPTANCE");
console.log("=========================");

await test("Public staging site",async()=>{
  const r=await req("/",{auth:false});
  ok(r.status===200,`HTTP ${r.status}`);
});

await test("Health endpoint",async()=>{
  const r=await req("/api/health",{auth:false});
  ok(r.status===200,`HTTP ${r.status}`);
  ok(r.headers.get("x-content-type-options")==="nosniff","nosniff header missing");
  ok(r.headers.get("x-request-id"),"request ID missing");
});

await test("Readiness endpoint responds",async()=>{
  const r=await req("/api/ready",{auth:false});
  ok([200,503].includes(r.status),`HTTP ${r.status}`);
  return `HTTP ${r.status}`;
});

await test("Protected API blocks anonymous users",async()=>{
  const r=await req("/api/apps",{auth:false});
  ok(r.status===401,`expected 401, got ${r.status}`);
});

await test("Hostile origin rejected",async()=>{
  const r=await req("/api/auth/login",{
    method:"POST",
    auth:false,
    origin:"https://attacker.invalid",
    body:{email:EMAIL,password:"invalid"}
  });
  ok(r.status===403,`expected 403, got ${r.status}`);
});

await test("Owner login",async()=>{
  const r=await req("/api/auth/login",{
    method:"POST",
    auth:false,
    origin:BASE,
    body:{email:EMAIL,password:PASSWORD}
  });

  ok(r.status>=200&&r.status<300,`HTTP ${r.status}`);

  const raw=r.headers.get("set-cookie")||"";
  const match=raw.match(/(__Host-feltus_session=[^;]+)/i);

  ok(match,"session cookie missing");
  ok(/HttpOnly/i.test(raw),"HttpOnly missing");
  ok(/Secure/i.test(raw),"Secure missing");
  ok(/SameSite=Strict/i.test(raw),"SameSite=Strict missing");

  cookie=match[1];
});

await test("Authenticated session",async()=>{
  const r=await req("/api/auth/session");
  ok(r.status===200,`HTTP ${r.status}`);
  ok(r.data?.authenticated===true,"session not authenticated");
});

await test("QA project persisted",async()=>{
  const r=await req("/api/apps");
  ok(r.status===200,`HTTP ${r.status}`);

  project=list(r.data).find(x=>
    String(x.app_name||x.name||"").toLowerCase()===PROJECT.toLowerCase()
  );

  ok(project,`"${PROJECT}" not found`);
  ok(project.id,"project ID missing");
  return project.id;
});

await test("QA asset persisted",async()=>{
  ok(project?.id,"project unavailable");

  const r=await req(`/api/assets?app_id=${encodeURIComponent(project.id)}`);
  ok(r.status===200,`HTTP ${r.status}`);

  const asset=list(r.data).find(x=>
    String(x.asset_name||x.name||"").toLowerCase()===ASSET.toLowerCase()
  );

  ok(asset,`"${ASSET}" not found`);
});

await test("QA model persisted with RLS",async()=>{
  ok(project?.id,"project unavailable");

  const r=await req(`/api/models?app_id=${encodeURIComponent(project.id)}`);
  ok(r.status===200,`HTTP ${r.status}`);

  const model=list(r.data).find(x=>
    String(x.logical_name||x.table_name||x.name||"").toLowerCase()===MODEL.toLowerCase()
  );

  ok(model,`"${MODEL}" not found`);
  ok(model.rls_enabled===true,"RLS is not enabled");
});

await test("Relationship service",async()=>{
  const r=await req(`/api/relationships?app_id=${encodeURIComponent(project.id)}`);
  ok(r.status===200,`HTTP ${r.status}`);
  return `${list(r.data).length} relationship(s)`;
});

await test("Invalid model ID rejected",async()=>{
  const r=await req("/api/models?app_id=not-a-uuid");
  ok(r.status===400,`expected 400, got ${r.status}`);
});

await test("Invalid relationship ID rejected",async()=>{
  const r=await req("/api/relationships?app_id=not-a-uuid");
  ok(r.status===400,`expected 400, got ${r.status}`);
});

await test("Documents service",async()=>{
  const r=await req(`/api/documents?app_id=${encodeURIComponent(project.id)}`);
  ok(r.status===200,`HTTP ${r.status}`);
  return `${list(r.data).length} document(s)`;
});

await test("Deployment state",async()=>{
  const r=await req(`/api/deployment?app_id=${encodeURIComponent(project.id)}`);
  ok(r.status===200,`HTTP ${r.status}`);
});

await test("Activity log",async()=>{
  const r=await req(`/api/activity?app_id=${encodeURIComponent(project.id)}`);
  ok(r.status===200,`HTTP ${r.status}`);
});

await test("System health",async()=>{
  const r=await req(`/api/system-health?app_id=${encodeURIComponent(project.id)}`);
  ok(r.status===200,`HTTP ${r.status}`);
});

await test("AI endpoint intentionally unavailable",async()=>{
  const r=await req(`/api/ai/status?app_id=${encodeURIComponent(project.id)}`);
  ok([200,503].includes(r.status),`HTTP ${r.status}`);
  return "known staging dependency";
},"KNOWN");

console.log("");
console.log("SUMMARY");
console.log("=======");

const pass=results.filter(x=>x.status==="PASS").length;
const fail=results.filter(x=>x.status==="FAIL").length;
const known=results.filter(x=>x.status==="KNOWN").length;

console.log(`PASS:  ${pass}`);
console.log(`FAIL:  ${fail}`);
console.log(`KNOWN: ${known}`);

console.log("");
console.log(fail===0 ? "FINAL: PASS WITH KNOWN DEPENDENCY" : "FINAL: FAIL");

process.exit(fail===0?0:1);

