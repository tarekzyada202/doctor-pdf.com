/* Doctor PDF — shared PDF form engine  (window.DpdfForm)
   ---------------------------------------------------------------------------
   Used by edit-pdf and by every page under /forms/. Moved here from
   edit-pdf.html on 2026-10-02 (code carried over verbatim; only the page
   wiring changed) — see CLAUDE.md. Runs 100% in the browser: the values a
   user types never leave their device. Requires pdf-lib (window.PDFLib).
   The page supplies translations: overlay(f,ds,t) and the length hint call
   t('tMaxChars'); the page shows its own toasts for unlock()/fill() results.
   CACHE: pages load this as /js/form-fill.js?v=… — bump ?v= on every change. */
(function(){
'use strict';

/* ── protected forms ───────────────────────────────────────────────────────
   Many government forms (USCIS N-400, …) are encrypted with an owner password
   that still allows filling. pdf-lib cannot read the form of an encrypted file,
   so those forms opened with ZERO fillable fields and no explanation. When an
   encrypted PDF carries a form we decrypt it with qpdf (same engine as the
   Unlock tool). No password is ever guessed: if the file needs a user password
   qpdf produces nothing and we keep the original bytes. Encrypted PDFs without
   a form are left exactly as they were. */
const QPDF_JS='https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.js';
const QPDF_JS_SRI='sha384-viHHfnvZlwDzjAQCrTUX3UR1zDr3OW9ItyLOqwH2wTHYHXWK8NdKi5LFp++BT8NL';
const QPDF_WASM='https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm';
let _qpdfScript=null;
function loadQpdfScript(){
  if(_qpdfScript)return _qpdfScript;
  _qpdfScript=new Promise((res,rej)=>{
    if(typeof Module==='function'){res();return;}
    const sc=document.createElement('script');
    sc.src=QPDF_JS;sc.integrity=QPDF_JS_SRI;sc.crossOrigin='anonymous';
    sc.onload=()=>typeof Module==='function'?res():rej(new Error('qpdf'));
    sc.onerror=()=>{_qpdfScript=null;rej(new Error('qpdf'));};
    document.head.appendChild(sc);
  });
  return _qpdfScript;
}
async function unlock(bytes,onBusy){
  let doc;try{doc=await PDFLib.PDFDocument.load(bytes,{ignoreEncryption:true,parseSpeed:PDFLib.ParseSpeeds.Fastest});}catch(e){return bytes;}
  if(!doc.isEncrypted||!doc.catalog.get(PDFLib.PDFName.of('AcroForm')))return bytes;
  try{
    if(onBusy)onBusy();
    await loadQpdfScript();
    const q=await Module({locateFile:()=>QPDF_WASM});   /* fresh instance per run */
    q.FS.writeFile('/in.pdf',bytes);
    try{q.callMain(['--decrypt','--','/in.pdf','/out.pdf']);}catch(e){}
    let out=null;try{out=q.FS.readFile('/out.pdf');}catch(e){}
    if(out&&out.length)return out;
  }catch(e){}
  return bytes;
}

/* ── Arabic in PDF form fields ────────────────────────────────────────────
   pdf-lib writes a field's appearance with the form's own /DA font (usually
   Helvetica/WinAnsi), which cannot encode Arabic at all — filling any field
   in Arabic used to abort the whole save. We embed a real Arabic font with
   fontkit, which shapes the letters (joining forms, lam-alef) for us.
   fontkit lays RTL runs out correctly BUT reverses digits inside them, so a
   plot number 1234 would silently become 4321. We therefore pre-reverse each
   non-Arabic run, let fontkit's own reversal put it back, and afterwards
   restore the real logical value so the STORED field value stays correct. */
const AR_RX=/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const FONTKIT_JS='https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js';
const FONTKIT_SRI='sha384-2p6U+1mmqF10USehFeRiyG2ESG9FwIqN+jxULn5w9jjQIihSn9Pt13dVCn/Hawjn';
const AR_FONT_URL='/fonts/Tajawal-Regular.ttf';
let _fontkitP=null,_arFontP=null;
function loadFontkit(){
  if(window.fontkit)return Promise.resolve(window.fontkit);
  if(!_fontkitP)_fontkitP=new Promise((res,rej)=>{const sc=document.createElement('script');
    sc.src=FONTKIT_JS;sc.integrity=FONTKIT_SRI;sc.crossOrigin='anonymous';
    sc.onload=()=>res(window.fontkit);sc.onerror=()=>rej(new Error('fontkit'));document.head.appendChild(sc);});
  return _fontkitP;
}
function loadArFont(){
  if(!_arFontP)_arFontP=fetch(AR_FONT_URL).then(r=>{if(!r.ok)throw new Error('font '+r.status);return r.arrayBuffer();});
  return _arFontP;
}
/* reverse every non-Arabic run, but only inside a string that HAS Arabic —
   a pure-Latin value must be left exactly as typed. */
function arFormText(v){
  if(!AR_RX.test(v))return v;
  return v.replace(/[^\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]+/g,function(m){
    if(!/\S/.test(m))return m;
    var lead=(m.match(/^\s*/)||[''])[0],trail=(m.match(/\s*$/)||[''])[0];
    var core=m.slice(lead.length,m.length-trail.length);
    return lead+core.split('').reverse().join('')+trail;
  });
}

/* A capped field (maxLength) used to just stop accepting keys at the limit with
   no explanation. While such a field has focus, show its limit and a live
   count under it, in the page language; it turns amber when full. */
function fieldHint(el,f,t){
  /* anchor the hint where the text STARTS: the field's right edge on an RTL page,
     its left edge on an LTR one. Anchored left, an Arabic hint ran off-screen on a
     scrolled page and hid the count. Re-placed on every keystroke because the
     count can gain a digit, and kept inside the page. */
  const place=h=>{
    const L=parseFloat(el.style.left)||0,W=parseFloat(el.style.width)||0,hw=h.offsetWidth;
    const x=document.documentElement.dir==='rtl'?L+W-hw:L;
    const max=Math.max(0,(el.parentNode.clientWidth||L+W)-hw);
    h.style.left=Math.min(Math.max(0,x),max)+'px';
  };
  const upd=h=>{h.textContent=t('tMaxChars').replace('{n}',f.maxLen)+' · '+el.value.length+'/'+f.maxLen;h.classList.toggle('full',el.value.length>=f.maxLen);place(h);};
  el.addEventListener('focus',()=>{
    let h=document.getElementById('fieldHint');
    if(!h){h=document.createElement('div');h.id='fieldHint';h.className='field-hint';}
    el.parentNode.appendChild(h);
    h.style.top=(parseFloat(el.style.top)+parseFloat(el.style.height)+3)+'px';
    h.style.display='block';upd(h);
  });
  el.addEventListener('input',()=>{const h=document.getElementById('fieldHint');if(h)upd(h);});
  el.addEventListener('blur',()=>{const h=document.getElementById('fieldHint');if(h)h.style.display='none';});
}
function read(doc,heights){
  const out=[];
  let form,fields;try{form=doc.getForm();fields=form.getFields();}catch(e){return out;}
  const libPages=doc.getPages();
  fields.forEach(field=>{
    let type=null;
    if(field instanceof PDFLib.PDFTextField)type='text';
    else if(field instanceof PDFLib.PDFCheckBox)type='check';
    else if(field instanceof PDFLib.PDFDropdown||field instanceof PDFLib.PDFOptionList)type='dropdown';
    else if(field instanceof PDFLib.PDFRadioGroup)type='radio';
    if(!type)return;
    const name=field.getName();let options=[];
    try{if(type==='dropdown'||type==='radio')options=field.getOptions();}catch(e){}
    /* a text field may cap its length (e.g. a 9-box A-Number). The overlay must
       enforce it: anything longer used to be typed, then silently dropped on save. */
    let maxLen=0;try{if(type==='text'){const m=field.getMaxLength();if(m)maxLen=m;}}catch(e){}
    let val='';try{if(type==='text')val=field.getText()||'';else if(type==='check')val=field.isChecked();else if(type==='dropdown'){const s=field.getSelected();val=(s&&s[0])||'';}}catch(e){}
    let widgets=[];try{widgets=field.acroField.getWidgets();}catch(e){}
    widgets.forEach(w=>{
      let r;try{r=w.getRectangle();}catch(e){return;}
      let pi=0;try{const pref=w.P&&w.P();if(pref)libPages.forEach((pg,i)=>{if(pg.ref===pref||(pg.ref&&pref&&pg.ref.objectNumber===pref.objectNumber))pi=i;});}catch(e){}
      const H=heights[pi];if(H==null)return;
      out.push({pi,type,name,options,value:val,orig:val,maxLen,x:r.x,y:H-(r.y+r.height),w:r.width,h:r.height});
    });
  });
  return out;
}

function overlay(f,ds,t){
    let el;
    if(f.type==='check'){el=document.createElement('input');el.type='checkbox';el.checked=!!f.value;el.onchange=()=>{f.value=el.checked;};}
    else if(f.type==='dropdown'||f.type==='radio'){el=document.createElement('select');(f.options||[]).forEach(o=>{const op=document.createElement('option');op.value=o;op.textContent=o;if(o===f.value)op.selected=true;el.appendChild(op);});el.onchange=()=>{f.value=el.value;};}
    else{el=document.createElement('input');el.type='text';if(f.maxLen)el.maxLength=f.maxLen;el.value=f.value||'';el.oninput=()=>{f.value=el.value;};}
    el.className='form-ov';el.title=f.name;el.style.cssText='position:absolute;box-sizing:border-box;z-index:6;border:1px solid var(--primary);background:rgba(99,102,241,.10);color:#111;padding:0 3px;border-radius:2px;font-family:inherit';
    el.style.left=(f.x*ds)+'px';el.style.top=(f.y*ds)+'px';
    if(f.type!=='check'){el.style.width=(f.w*ds)+'px';el.style.height=(f.h*ds)+'px';el.style.fontSize=Math.max(9,Math.min(f.h*ds*0.62,22))+'px';}
    else{el.style.width=el.style.height=Math.min(f.w,f.h)*ds+'px';}
    if(f.type==='text'&&f.maxLen)fieldHint(el,f,t);
    return el;
}

async function fill(src,fields){
  const form=src.getForm();
  const byName={};fields.forEach(f=>{byName[f.name]=f;});
  const vals=Object.values(byName).filter(f=>f.value!==f.orig);
  const txt=f=>String(f.value==null?'':f.value);
  const needAr=vals.some(f=>f.type==='text'&&AR_RX.test(txt(f)));
  let arFont=null;
  if(needAr){try{
    const fk=await loadFontkit();src.registerFontkit(fk);
    arFont=await src.embedFont(new Uint8Array(await loadArFont()),{subset:true});
  }catch(e){arFont=null;}}
  const lost=[];
  vals.forEach(f=>{try{
    if(f.type==='text'){const v=txt(f);form.getTextField(f.name).setText(arFont?arFormText(v):v);}
    else if(f.type==='check'){const c=form.getCheckBox(f.name);f.value?c.check():c.uncheck();}
    else if(f.type==='dropdown'){if(f.value)form.getDropdown(f.name).select(String(f.value));}
    else if(f.type==='radio'){if(f.value)form.getRadioGroup(f.name).select(String(f.value));}
  }catch(e){if(f.type==='text'&&txt(f))lost.push(f.name);}});
  if(arFont){
    try{form.updateFieldAppearances(arFont);}catch(e){}
    /* appearance is baked — put the true logical text back as the stored value */
    vals.forEach(f=>{try{if(f.type==='text')form.getTextField(f.name).setText(txt(f));}catch(e){}});
  }
  return {arFont,lost};
}

function load(bytes){return PDFLib.PDFDocument.load(bytes,{ignoreEncryption:true,parseSpeed:PDFLib.ParseSpeeds.Fastest});}
/* serialise in one go: pdf-lib's default per-50-object yields crawl when the
   browser throttles timers. When Arabic was written, the appearances are
   already baked from the display-order text — do not regenerate them. */
function save(src,st){return src.save(Object.assign({objectsPerTick:Infinity},st&&st.arFont?{updateFieldAppearances:false}:{}));}

window.DpdfForm={load,read,overlay,fill,save,unlock,arText:arFormText,hasArabic:v=>AR_RX.test(v),loadFontkit,loadArFont};
})();
