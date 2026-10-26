import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from 'file:///C:/Users/majet/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';

const workspaceDir = 'D:/SAMPLE_PROJECTS/project1';
const buildDir = path.join(workspaceDir, '.video-build');
const outputDir = path.join(workspaceDir, 'video-output');
const skillDir = 'C:/Users/majet/.codex/plugins/cache/openai-primary-runtime/presentations/26.1025.11240/skills/presentations';
const finalPptx = path.join(outputDir, 'bellevue-public-records-poc-storyboard.pptx');
const W = 1280, H = 720;
const colors = { bg: '#081A24', panel: '#102A36', line: '#285261', mint: '#64E3C3', sky: '#7CC7FF', text: '#F4F8FA', muted: '#A6BAC4', amber: '#FFD27A' };

await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });
const p = Presentation.create({ slideSize: { width: W, height: H } });

function shape(slide, geometry, x, y, w, h, fill='none', lineFill='none') {
  return slide.shapes.add({ geometry, position: { left:x, top:y, width:w, height:h }, fill,
    line: { style:'solid', fill:lineFill, width:lineFill==='none' ? 0 : 1.5 } });
}
function text(slide, value, x, y, w, h, size, color=colors.text, bold=false) {
  const s=shape(slide,'textbox',x,y,w,h);
  s.text=value;
  s.text.style={fontFamily:'Segoe UI',fontSize:size,color,bold,verticalAlignment:'middle',wrap:true};
  return s;
}
function chrome(slide, eyebrow, index) {
  slide.background.fill=colors.bg;
  shape(slide,'rect',0,0,W,8,colors.mint);
  text(slide,'PUBLIC RECORDS SEARCH',64,30,400,30,15,colors.mint,true);
  text(slide,'BELLEVUE POC',1020,30,195,30,14,colors.muted,true);
  text(slide,eyebrow.toUpperCase(),66,117,800,26,15,colors.sky,true);
  shape(slide,'rect',0,700,W,20,'#153441');
  shape(slide,'rect',0,700,(index+1)/8*W,20,colors.mint);
}
function title(slide, h, sub) {
  text(slide,h,66,165,1110,68,48,colors.text,true);
  text(slide,sub,68,242,1080,60,23,colors.muted,false);
}
function card(slide,x,y,w,h,label,headline,body,accent=colors.mint) {
  shape(slide,'roundRect',x,y,w,h,colors.panel,colors.line);
  text(slide,label.toUpperCase(),x+22,y+18,w-44,24,12,accent,true);
  text(slide,headline,x+22,y+50,w-44,34,21,colors.text,true);
  text(slide,body,x+22,y+91,w-44,h-105,16,colors.muted,false);
}
function footer(slide, body) {
  shape(slide,'roundRect',66,595,1148,72,'#0E2A36',colors.line);
  text(slide,body,88,605,1095,51,16,colors.text,false);
}

// 1 — Opening
{
  const s=p.slides.add(); chrome(s,'Round 2 · B1 · pre-access demo',0);
  text(s,'Find likely records earlier.',66,190,720,72,48,colors.text,true);
  text(s,'Keep decisions with staff.',68,275,690,53,31,colors.mint,true);
  text(s,'A staff-only search assistant concept for public-records work.',70,346,600,65,20,colors.muted,false);
  card(s,790,310,390,188,'DEMO CORPUS','18 invented records','18 invented requests\nNo city systems or live records',colors.sky);
  footer(s,'Synthetic-only walkthrough. This is a local prototype, not a City of Bellevue service.');
}
// 2 — Request language
{
  const s=p.slides.add(); chrome(s,'The challenge',1); title(s,'One idea, several phrases','Keyword search depends on the words used in the document.');
  card(s,66,355,345,150,'REQUEST WORDS','Road closure','What the requester may call it');
  text(s,'→',426,406,60,50,34,colors.sky,true);
  card(s,486,355,345,150,'DOCUMENT WORDS','Right-of-way work','How a record may describe it',colors.sky);
  text(s,'→',846,406,60,50,34,colors.sky,true);
  card(s,906,355,308,150,'RELATED TERMS','Detour · lane shift','A broader term set to review');
  footer(s,'The prototype expands terms with a curated synonym list. It does not use embeddings or an LLM.');
}
// 3 — Invented request
{
  const s=p.slides.add(); chrome(s,'Invented request',2); title(s,'Cedar Avenue utility work','A single example to compare two retrieval approaches.');
  shape(s,'roundRect',100,344,1080,158,colors.panel,colors.line);
  text(s,'“Please send records about the road closure on Cedar Avenue',130,372,1000,39,23,colors.text,false);
  text(s,'while utility crews did their work.”',130,420,1000,39,23,colors.text,false);
  text(s,'REQUEST SCENARIO · SYNTHETIC',130,468,600,20,12,colors.mint,true);
  footer(s,'Every request and record shown in this video is invented for the demo.');
}
// 4 — Search plan
{
  const s=p.slides.add(); chrome(s,'Staff-reviewed plan',3); title(s,'Edit the plan before searching','Staff can refine the scope and terms, then confirm the plan.');
  card(s,76,350,530,190,'TOPICS','Road closure · Cedar Avenue','Request text remains visible for staff review.');
  card(s,652,350,550,190,'ALTERNATE TERMS','Utility work · lane closure','Right-of-way work · detour',colors.sky);
  footer(s,'The search-plan draft uses local rules. Staff review and confirmation are required in this demo.');
}
// 5 — Ranked candidates
{
  const s=p.slides.add(); chrome(s,'Ranked candidates',4); title(s,'Show evidence with each result','Candidates include a matching passage and a reason for display.');
  card(s,72,348,548,190,'R-001 · TRANSPORTATION','Roadway right-of-way work notice','“...utility work along Cedar Avenue. The notice describes a lane closure and detour.”');
  card(s,660,348,548,190,'R-002 · TRANSPORTATION','Cedar Avenue coordination email','“Crews planned to close one travel lane overnight and post a signed detour.”',colors.sky);
  footer(s,'Search ranks candidates. Staff decide responsiveness, privilege, exemptions, redaction, and release.');
}
// 6 — Synthetic results
{
  const s=p.slides.add(); chrome(s,'Synthetic benchmark · 6 different-wording requests',5); title(s,'Curated synonyms improved this demo set','Plain keyword compared with synonym-expanded lexical search.');
  const rows=[['Recall @ 10','87.1%','100%'],['Precision @ 10','23.3%','31.7%'],['Recall @ 50','90.5%','100%'],['Precision @ 50','13.9%','17.6%']];
  shape(s,'roundRect',90,337,1100,205,colors.panel,colors.line);
  text(s,'METRIC',120,350,260,25,13,colors.muted,true);text(s,'KEYWORD',520,350,220,25,13,colors.muted,true);text(s,'SYNONYM + KEYWORD',820,350,310,25,13,colors.muted,true);
  rows.forEach((r,i)=>{const yy=389+i*36;text(s,r[0],120,yy,310,29,17,colors.text,true);text(s,r[1],520,yy,220,29,17,colors.muted,true);text(s,r[2],820,yy,240,29,17,colors.mint,true)});
  footer(s,'Synthetic demo results only. Top 50 uses the full 18-record corpus. Target outcomes to be validated during discovery.');
}
// 7 — Human review and logs
{
  const s=p.slides.add(); chrome(s,'Staff review and search log',6); title(s,'Review, annotate, and export','Keep a trace of the plan, candidates, and staff review.');
  card(s,78,350,345,175,'REVIEW MARKS','Relevant · not relevant','Add a note to a candidate.');
  card(s,468,350,345,175,'LABEL WORKSHEET','Two reviewers + adjudication','Workflow is provided; human review is not completed.',colors.sky);
  card(s,858,350,345,175,'SEARCH LOG','JSON export','Local draft log, not a City audit store.',colors.amber);
  footer(s,'The POC does not disclose, redact, or exempt records and does not decide when a search is complete.');
}
// 8 — Boundary and next step
{
  const s=p.slides.add(); chrome(s,'Prototype boundary',7); title(s,'Staff decide. The tool finds.','The demo covers a synthetic workflow, not production access.');
  card(s,90,348,520,172,'INCLUDED','Synthetic request-to-review flow','Search plan · candidate ranking · review · export');
  card(s,670,348,520,172,'NOT CONNECTED','City data or AI services','Human label adjudication and SureAccess review remain required.',colors.amber);
  footer(s,'Future access depends on Bellevue approval, approved hosting, and agreed data-sharing gates.');
}

// Render all slides for a visual QA contact sheet, and export the editable storyboard.
for (let i=0;i<p.slides.items.length;i++) {
  const blob=await p.export({slide:p.slides.items[i],format:'png',scale:1});
  await fs.writeFile(path.join(buildDir,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await blob.arrayBuffer()));
}
const candidate=path.join(buildDir,'candidate.pptx');
await (await PresentationFile.exportPptx(p)).save(candidate);
const { finalizePresentation }=await import(pathToFileURL(path.join(skillDir,'container_tools/artifact_tool_utils.mjs')).href);
const staging=path.join(buildDir,'finalizer');await fs.mkdir(staging,{recursive:true});
const report=await finalizePresentation({workspaceDir,candidatePath:candidate,finalPath:finalPptx,pythonExecutable:'C:/Users/majet/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',integrityValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_layout_geometry.py'),layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],requiredNativeTableOwnerSlides:[],fontPolicy:{basis:'design',families:['Aptos']},verifyArtifactToolImport:true,receiptPath:path.join(staging,'validation.json')});
console.log(JSON.stringify({pptx:finalPptx,slides:p.slides.items.length,report},null,2));
