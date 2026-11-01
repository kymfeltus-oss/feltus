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

await test("Relationship create, verify, delete",async()=>{
  ok(project?.id,"project unavailable");

  let modelsResponse=await req(
    `/api/models?app_id=${encodeURIComponent(project.id)}`
  );
  ok(modelsResponse.status===200,`models HTTP ${modelsResponse.status}`);

  let models=list(modelsResponse.data);

  const targetModel=models.find(x=>
    String(x.logical_name||x.table_name||x.name||"").toLowerCase()===MODEL.toLowerCase()
  );

  ok(targetModel,`target model "${MODEL}" not found`);
  ok(targetModel.id,"target model ID missing");

  let probeModel=models.find(x=>
    String(x.logical_name||x.table_name||x.name||"").toLowerCase()==="qa_relationship_probe"
  );

  if(!probeModel){
    const createProbe=await req("/api/models",{
      method:"POST",
      origin:BASE,
      body:{
        app_id:project.id,
        table_name:"qa_relationship_probe",
        columns:[
          {
            name:"qa_item_id",
            type:"uuid",
            nullable:true
          }
        ],
        enable_rls:true
      }
    });

    ok(
      createProbe.status>=200&&createProbe.status<300,
      `probe model creation HTTP ${createProbe.status}: ${createProbe.text}`
    );

    modelsResponse=await req(
      `/api/models?app_id=${encodeURIComponent(project.id)}`
    );
    ok(modelsResponse.status===200,`models refresh HTTP ${modelsResponse.status}`);

    models=list(modelsResponse.data);

    probeModel=models.find(x=>
      String(x.logical_name||x.table_name||x.name||"").toLowerCase()==="qa_relationship_probe"
    );
  }

  ok(probeModel,"qa_relationship_probe not found after creation");
  ok(probeModel.id,"probe model ID missing");
  ok(probeModel.rls_enabled===true,"probe model RLS is not enabled");

  let relationshipsResponse=await req(
    `/api/relationships?app_id=${encodeURIComponent(project.id)}`
  );
  ok(
    relationshipsResponse.status===200,
    `relationships HTTP ${relationshipsResponse.status}`
  );

  let relationships=list(relationshipsResponse.data);

  const matchesAuditRelationship=x=>
    x.source_model_id===probeModel.id &&
    x.source_column==="qa_item_id" &&
    x.target_model_id===targetModel.id &&
    x.target_column==="id";

  const stale=relationships.find(matchesAuditRelationship);

  if(stale?.id){
    const cleanup=await req("/api/relationships/delete",{
      method:"POST",
      origin:BASE,
      body:{
        relationship_id:stale.id
      }
    });

    ok(
      cleanup.status>=200&&cleanup.status<300,
      `stale relationship cleanup HTTP ${cleanup.status}`
    );
  }

  const createRelationship=await req("/api/relationships",{
    method:"POST",
    origin:BASE,
    body:{
      app_id:project.id,
      source_model_id:probeModel.id,
      source_column:"qa_item_id",
      target_model_id:targetModel.id,
      target_column:"id",
      on_delete:"RESTRICT"
    }
  });

  ok(
    createRelationship.status>=200&&createRelationship.status<300,
    `relationship creation HTTP ${createRelationship.status}: ${createRelationship.text}`
  );

  relationshipsResponse=await req(
    `/api/relationships?app_id=${encodeURIComponent(project.id)}`
  );
  ok(
    relationshipsResponse.status===200,
    `relationship verification HTTP ${relationshipsResponse.status}`
  );

  relationships=list(relationshipsResponse.data);

  const createdRelationship=relationships.find(matchesAuditRelationship);

  ok(createdRelationship,"created relationship was not returned by API");
  ok(createdRelationship.id,"created relationship ID missing");

  const removeRelationship=await req("/api/relationships/delete",{
    method:"POST",
    origin:BASE,
    body:{
      relationship_id:createdRelationship.id
    }
  });

  ok(
    removeRelationship.status>=200&&removeRelationship.status<300,
    `relationship deletion HTTP ${removeRelationship.status}: ${removeRelationship.text}`
  );

  const finalResponse=await req(
    `/api/relationships?app_id=${encodeURIComponent(project.id)}`
  );
  ok(
    finalResponse.status===200,
    `final relationship verification HTTP ${finalResponse.status}`
  );

  const stillExists=list(finalResponse.data).find(matchesAuditRelationship);

  ok(!stillExists,"audit relationship still exists after deletion");

  return "create -> verify -> delete";
});

await test("Invalid model ID rejected",async()=>{
  const r=await req("/api/models?app_id=not-a-uuid");
  ok(r.status===400,`expected 400, got ${r.status}`);
});

await test("Invalid relationship ID rejected",async()=>{
  const r=await req("/api/relationships?app_id=not-a-uuid");
  ok(r.status===400,`expected 400, got ${r.status}`);
});

await test("Document upload, process, readback",async()=>{
  ok(project?.id,"project unavailable");

  const qaDocumentName="feltus-staging-acceptance.txt";

  const qaDocumentContent=[
    "FELTUS staging acceptance document.",
    `Project: ${PROJECT}`,
    "This file verifies private document storage, parsing, chunking, and retrieval."
  ].join("\n");

  let documentsResponse=await req(
    `/api/documents?app_id=${encodeURIComponent(project.id)}`
  );

  ok(
    documentsResponse.status===200,
    `documents HTTP ${documentsResponse.status}`
  );

  let documents=list(documentsResponse.data);

  let document=documents.find(x=>
    String(x.original_name||"").toLowerCase()===qaDocumentName.toLowerCase()
  );

  if(!document){
    const uploadResponse=await fetch(
      `${BASE}/api/documents/upload?app_id=${encodeURIComponent(project.id)}&name=${encodeURIComponent(qaDocumentName)}`,
      {
        method:"POST",
        headers:{
          cookie,
          origin:BASE,
          "content-type":"text/plain; charset=utf-8"
        },
        body:qaDocumentContent,
        redirect:"manual"
      }
    );

    const uploadText=await uploadResponse.text();

    let uploadData=null;

    try{
      uploadData=uploadText
        ? JSON.parse(uploadText)
        : null;
    }catch{
      uploadData=uploadText;
    }

    ok(
      uploadResponse.status===201,
      `document upload HTTP ${uploadResponse.status}: ${uploadText}`
    );

    document=uploadData;
  }

  ok(document?.id,"QA document ID missing");

  const processResponse=await req("/api/documents/process",{
    method:"POST",
    origin:BASE,
    body:{
      document_id:document.id
    }
  });

  ok(
    processResponse.status===200,
    `document processing HTTP ${processResponse.status}: ${processResponse.text}`
  );

  ok(
    processResponse.data?.processing_status==="ready",
    `expected ready, got ${processResponse.data?.processing_status}`
  );

  ok(
    Number(processResponse.data?.chunk_count)>0,
    "document processing returned no chunks"
  );

  documentsResponse=await req(
    `/api/documents?app_id=${encodeURIComponent(project.id)}`
  );

  ok(
    documentsResponse.status===200,
    `document readback HTTP ${documentsResponse.status}`
  );

  documents=list(documentsResponse.data);

  const storedDocument=documents.find(x=>
    x.id===document.id
  );

  ok(storedDocument,"processed document was not returned by /api/documents");

  ok(
    storedDocument.processing_status==="ready",
    `stored document status is ${storedDocument.processing_status}`
  );

  const chunksResponse=await req(
    `/api/document-chunks?document_id=${encodeURIComponent(document.id)}`
  );

  ok(
    chunksResponse.status===200,
    `document chunks HTTP ${chunksResponse.status}`
  );

  const chunks=list(chunksResponse.data);

  ok(
    chunks.length>0,
    "no stored document chunks returned"
  );

  const combinedContent=chunks
    .map(x=>String(x.content||""))
    .join("\n");

  ok(
    combinedContent.includes("FELTUS staging acceptance document"),
    "stored chunk content does not match QA document"
  );

  return `ready - ${chunks.length} chunk(s)`;
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



