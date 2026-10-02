/* Doctor PDF — runtime for the form pages under /forms/
   ---------------------------------------------------------------------------
   Opens the hosted official form already loaded and fillable on its own page:
   no upload, no separate tool. The blank form comes from our server; whatever
   the visitor types stays in their browser and is written into the PDF here.
   Needs pdf.js, pdf-lib and js/form-fill.js (window.DpdfForm).
   Page config (inline, before this script):
     window.DPDF_FORM = { file, slug, links:[leafName,…], t:{…messages…} }
   CACHE: pages load this as /js/form-page.js?v=… — bump ?v= on every change. */
(function(){
'use strict';
const C=window.DPDF_FORM||{};
const t=k=>(C.t&&C.t[k])||k;
const $=id=>document.getElementById(id);
let bytes=null, pages=[], fields=[], zoom=1, io=null, gen=0, lastW=0;

pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function toast(msg,type){
  const w=$('toastWrap');if(!w)return;
  const d=document.createElement('div');d.className='toast'+(type==='error'?' error':'');
  d.textContent=msg;w.appendChild(d);setTimeout(()=>d.remove(),3500);
}

/* ── nav: same behaviour as every tool page ── */
function applyTheme(dark){
  document.documentElement.setAttribute('data-theme',dark?'dark':'');
  const s=$('iconSun'),m=$('iconMoon');if(s)s.style.display=dark?'none':'';if(m)m.style.display=dark?'':'none';
  try{localStorage.setItem('dpdf_dark',dark?'1':'0');}catch(e){}
}
function wireNav(){
  let dark=false;try{dark=localStorage.getItem('dpdf_dark')==='1';}catch(e){}
  if(!dark&&document.documentElement.getAttribute('data-theme')==='dark')dark=true;
  applyTheme(dark);
  const tb=$('themeBtn');if(tb)tb.onclick=()=>applyTheme(document.documentElement.getAttribute('data-theme')!=='dark');
  const bt=$('toolsBtn'),mn=$('toolsMenu');
  if(bt&&mn){bt.onclick=e=>{e.stopPropagation();mn.classList.toggle('open');};document.addEventListener('click',()=>mn.classList.remove('open'));}
}

/* ── fields that repeat across pages (e.g. the N-400 A-Number on all 14 pages):
   the official form keeps them in sync with XFA scripts, which pdf-lib drops,
   so a visitor would have to type the same number 14 times. Only the leaf names
   listed for THIS form are linked — a guess here could silently fill the wrong
   box, so it is declared per form, never inferred. ── */
const leaf=n=>n.replace(/\[\d+\]/g,'').split('.').pop();
const linked=new Set(C.links||[]);
function sync(f){
  const L=leaf(f.name);if(!linked.has(L))return;
  fields.forEach(g=>{
    if(g===f||g.type!==f.type||leaf(g.name)!==L)return;
    g.value=f.value;
    if(g._el){if(g.type==='check')g._el.checked=!!g.value;else g._el.value=g.value==null?'':g.value;}
  });
}

/* ── layout ── */
function scaleFor(p){
  const area=$('pagesArea');const w=Math.max(200,area.clientWidth-32);
  const fit=w/p.nativeW;
  /* on a phone a fit-to-width page makes form boxes ~7 px tall — too small to
     tap. Keep at least natural size there; the page scrolls sideways instead. */
  const base=area.clientWidth<600?Math.max(fit,1):Math.min(fit,2);
  return base*zoom;
}
function build(){
  const area=$('pagesArea');area.innerHTML='';gen++;
  fields.forEach(f=>{f._el=null;});
  if(io)io.disconnect();
  io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)renderPage(+e.target.dataset.i);}),{root:area,rootMargin:'600px'});
  pages.forEach((p,i)=>{
    p.ds=scaleFor(p);p.done=false;p.busy=false;
    const wrap=document.createElement('div');wrap.className='pg-wrap';wrap.dataset.i=i;
    wrap.style.width=Math.round(p.nativeW*p.ds)+'px';wrap.style.height=Math.round(p.nativeH*p.ds)+'px';
    p.wrap=wrap;area.appendChild(wrap);io.observe(wrap);
  });
  lastW=area.clientWidth;
  $('zoomPct').textContent=Math.round(zoom*100)+'%';
}
async function renderPage(i){
  const p=pages[i];if(!p||p.done||p.busy)return;p.busy=true;const my=gen;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  const vp=p.pg.getViewport({scale:p.ds*dpr});
  const cv=document.createElement('canvas');cv.width=Math.round(vp.width);cv.height=Math.round(vp.height);
  cv.style.width=Math.round(p.nativeW*p.ds)+'px';cv.style.height=Math.round(p.nativeH*p.ds)+'px';
  try{await p.pg.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;}catch(e){p.busy=false;return;}
  if(my!==gen){p.busy=false;return;}
  p.wrap.appendChild(cv);
  fields.filter(f=>f.pi===i).forEach(f=>{
    const el=DpdfForm.overlay(f,p.ds,t);f._el=el;
    el.addEventListener('input',()=>sync(f));el.addEventListener('change',()=>sync(f));
    p.wrap.appendChild(el);
  });
  p.done=true;p.busy=false;
}
function setZoom(z){zoom=Math.max(0.5,Math.min(3,z));build();}

/* ── load the official form ── */
async function load(){
  const area=$('pagesArea');
  try{
    const r=await fetch(C.file);if(!r.ok)throw new Error('http '+r.status);
    bytes=new Uint8Array(await r.arrayBuffer());
    bytes=await DpdfForm.unlock(bytes,()=>toast(t('tFormPrep')));
    const doc=await pdfjsLib.getDocument({isEvalSupported:false,data:bytes.slice(0)}).promise;
    pages=[];
    for(let i=1;i<=doc.numPages;i++){const pg=await doc.getPage(i);const vp=pg.getViewport({scale:1});pages.push({pg,nativeW:vp.width,nativeH:vp.height});}
    fields=DpdfForm.read(await DpdfForm.load(bytes),pages.map(p=>p.nativeH));
    $('statPages').textContent=pages.length;
    $('statFields').textContent=fields.filter(f=>!/BarCode/i.test(f.name)).length;
    $('fillBtn').disabled=false;
    build();
  }catch(e){
    area.innerHTML='';const m=document.createElement('div');m.className='form-msg';m.textContent=t('loadErr');area.appendChild(m);
  }
}

/* ── download the filled form ── */
async function downloadFilled(){
  const btn=$('fillBtn');btn.disabled=true;
  try{
    const src=await DpdfForm.load(bytes);
    const st=await DpdfForm.fill(src,fields);
    if(st.lost.length)toast(t('tFormLost').replace('{n}',st.lost.length),'error');
    const out=await DpdfForm.save(src,st);
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([out],{type:'application/pdf'}));
    a.download=C.slug+'-filled.pdf';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(a.href),5000);
    if(!st.lost.length)toast(t('saved'));
    if(typeof gtag==='function')gtag('event','form_filled',{form:C.slug});
  }catch(e){toast(t('saveErr'),'error');}
  btn.disabled=false;
}

function boot(){
  wireNav();
  $('fillBtn').onclick=downloadFilled;
  $('zoomIn').onclick=()=>setZoom(zoom*1.25);
  $('zoomOut').onclick=()=>setZoom(zoom/1.25);
  $('zoomPct').onclick=()=>setZoom(1);
  let rt=null;window.addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(()=>{
    const w=$('pagesArea').clientWidth;if(pages.length&&Math.abs(w-lastW)>40)build();},200);});
  load();
}
boot();
window.DpdfFormPage={get fields(){return fields;},get pages(){return pages;},downloadFilled,setZoom};
})();
