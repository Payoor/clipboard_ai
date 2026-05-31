import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import "./App.css";

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CONFIG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const API        = "http://192.168.100.226";
const CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_HIST   = 40;

const DIMS = [
  { label:"16:9",  w:1920,h:1080, desc:"YouTube"  },
  { label:"9:16",  w:1080,h:1920, desc:"Reels"    },
  { label:"1:1",   w:1080,h:1080, desc:"Square"   },
  { label:"4:5",   w:1080,h:1350, desc:"Portrait" },
  { label:"4:3",   w:1440,h:1080, desc:"Classic"  },
  { label:"21:9",  w:2560,h:1080, desc:"Cinema"   },
  { label:"Custom",w:1920,h:1080, desc:"Custom"   },
];
const PALETTE = ["#4C3BCF","#1A6B8A","#6B2D82","#1A6B51","#8A2D2D","#2D4A8A","#7A4F1A","#2D6B42"];

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INDEXEDDB  — persist blobs + project meta across refreshes
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const DB = (() => {
  let _db = null;
  const open = () => new Promise((res, rej) => {
    if (_db) { res(_db); return; }
    const req = indexedDB.open("clipmind_v2", 1);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains("blobs"))    d.createObjectStore("blobs");
      if (!d.objectStoreNames.contains("projects")) d.createObjectStore("projects");
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror   = () => rej(req.error);
  });
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      if (r) { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }
      else   { t.oncomplete = () => res(); t.onerror = () => rej(t.error); }
    });
  };
  return {
    saveBlob:    (id, blob) => tx("blobs","readwrite", s => { s.put(blob, id); }),
    loadBlob:    (id)       => tx("blobs","readonly",  s => s.get(id)),
    deleteBlob:  (id)       => tx("blobs","readwrite", s => { s.delete(id); }),
    saveProjects:(ps)       => tx("projects","readwrite", s => {
      s.put(ps.map(p => ({
        ...p,
        clips: p.clips.map(c => ({ ...c, file: undefined })),
      })), "all");
    }),
    loadProjects: ()        => tx("projects","readonly", s => s.get("all")),
  };
})();

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   UTILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const uid      = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
const fmtBytes = b => b>=1073741824?`${(b/1073741824).toFixed(2)}GB`:b>=1048576?`${(b/1048576).toFixed(1)}MB`:`${(b/1024).toFixed(0)}KB`;
const fmtSecs  = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(Math.floor(s%60)).padStart(2,"0")}`;
const fmtRuler = s => `${String(Math.floor(s/60)).padStart(2,"0")}.${String(Math.floor(s%60)).padStart(2,"0")}`;
const clamp    = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clipDur  = c => c.outPoint - c.inPoint;          // visual duration on timeline

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   FRAME EXTRACTOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const extractFrames = (url, n=22) => new Promise(res => {
  const v=document.createElement("video"), c=document.createElement("canvas");
  c.width=80; c.height=45;
  const ctx=c.getContext("2d"); let i=0; const out=[];
  v.muted=true; v.playsInline=true;
  v.onloadedmetadata = () => {
    const step = v.duration / n;
    const next = () => { if(i>=n){res(out);return;} v.currentTime=Math.min(step*i,v.duration-0.1); };
    v.onseeked = () => { ctx.drawImage(v,0,0,80,45); out.push(c.toDataURL("image/jpeg",0.6)); i++; next(); };
    next();
  };
  v.onerror = () => res([]);
  v.src = url;
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WAVEFORM EXTRACTOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const extractWaveform = async (file, samples=160) => {
  try {
    const ab=await file.arrayBuffer();
    const ac=new (window.AudioContext||window.webkitAudioContext)();
    const buf=await ac.decodeAudioData(ab); await ac.close();
    const ch=buf.getChannelData(0), blk=Math.floor(ch.length/samples);
    return Array.from({length:samples},(_,i)=>{
      let pk=0; for(let j=0;j<blk;j++){const v=Math.abs(ch[i*blk+j]||0);if(v>pk)pk=v;} return pk;
    });
  } catch {
    return Array.from({length:samples},(_,i)=>0.3+0.5*Math.abs(Math.sin(i*0.18+1))+Math.random()*0.15);
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   UPLOAD API
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const apiInit = async (file, sid) => {
  const ec=Math.ceil(file.size/CHUNK_SIZE);
  const payload={session_id:sid,chunk_size:CHUNK_SIZE,expected_chunks:ec,filename:file.name,file_size:file.size};
  const res=await fetch(`${API}/api/upload/init`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  if(!res.ok) throw new Error(`Server ${res.status}`);
  return {payload, response:await res.json().catch(()=>({})), expectedChunks:ec};
};
const apiChunk=(sid,i,blob)=>{
  const fd=new FormData(); fd.append("session_id",sid); fd.append("chunk_index",String(i)); fd.append("chunk",blob,`c${i}`);
  return fetch(`${API}/api/upload/chunk`,{method:"POST",body:fd});
};
const apiExport=async b=>{const r=await fetch(`${API}/api/export`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status);return r.json();};
const apiJobStatus=async id=>{const r=await fetch(`${API}/api/export/${id}`);return r.json();};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LOCAL EXPORT  (Canvas + MediaRecorder)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const localExport = async (proj, onProgress, signal) => {
  const dimW = proj.dimension.label==="Custom" ? proj.customW||1920 : proj.dimension.w;
  const dimH = proj.dimension.label==="Custom" ? proj.customH||1080 : proj.dimension.h;

  const cvs = document.createElement("canvas");
  cvs.width=dimW; cvs.height=dimH;
  const ctx = cvs.getContext("2d");
  const stream = cvs.captureStream(30);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")?"video/webm;codecs=vp9":"video/webm";
  const rec = new MediaRecorder(stream, {mimeType:mime});
  const chunks = [];
  rec.ondataavailable = e => { if(e.data.size>0) chunks.push(e.data); };
  rec.start(200);

  const orderedClips = [...proj.clips].sort((a,b)=>a.startTime-b.startTime);
  let done = 0;

  for (const clip of orderedClips) {
    if (signal?.aborted) break;
    const vid = document.createElement("video");
    vid.src = clip.objectUrl; vid.muted = true;
    await new Promise(r => { vid.onloadeddata=r; vid.onerror=r; vid.load(); });
    vid.currentTime = clip.inPoint;
    await new Promise(r => vid.onseeked=r);

    await new Promise(res => {
      let rafId;
      const draw = () => {
        if (signal?.aborted || vid.currentTime >= clip.outPoint) {
          cancelAnimationFrame(rafId);
          vid.pause();
          res();
          return;
        }
        ctx.drawImage(vid, 0,0, dimW,dimH);
        onProgress(Math.round(((done + (vid.currentTime-clip.inPoint)/clipDur(clip)) / orderedClips.length)*100));
        rafId = requestAnimationFrame(draw);
      };
      vid.play().then(() => { rafId = requestAnimationFrame(draw); });
      vid.ontimeupdate = () => { if(vid.currentTime >= clip.outPoint){ vid.pause(); } };
    });
    done++;
  }

  rec.stop();
  const blob = await new Promise(r => rec.onstop = () => r(new Blob(chunks,{type:mime})));
  return URL.createObjectURL(blob);
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PROJECT FACTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const mkProject = (name="Untitled Project") => ({
  id:uid(), name,
  clips:[], audioClips:[],
  selectedId:null, selectedAudioId:null,
  currentTime:0, zoom:80, isPlaying:false,
  dimension:DIMS[0], customW:1920, customH:1080,
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WAVEFORM CANVAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function WaveCanvas({data,width,height=40,color="rgba(210,190,255,0.85)"}){
  const ref=useRef();
  useEffect(()=>{
    const c=ref.current; if(!c||!data?.length)return;
    c.width=width; c.height=height;
    const ctx=c.getContext("2d"); ctx.clearRect(0,0,width,height);
    const bw=width/data.length;
    data.forEach((v,i)=>{
      const bh=Math.max(2,v*height*0.88);
      ctx.fillStyle=color;
      ctx.fillRect(i*bw,(height-bh)/2,Math.max(bw-0.5,1),bh);
    });
  },[data,width,height,color]);
  return <canvas ref={ref} style={{display:"block"}} />;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TRIM HANDLE  (left / right edge of clip)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function TrimHandle({side, onTrim}){
  const onMouseDown = e => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const onMove = ev => onTrim(ev.clientX - startX, false);
    const onUp   = ev => { onTrim(ev.clientX - startX, true); window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp); };
    window.addEventListener("mousemove",onMove);
    window.addEventListener("mouseup",onUp);
  };
  return <div className={`trim-handle trim-handle--${side}`} onMouseDown={onMouseDown} />;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   VIDEO CLIP  — individual timeline component
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function VideoClip({clip, pps, isActive, tool, onSelect, onMove, onTrimL, onTrimR, onCtxMenu, onCut}){
  const [hoverX, setHoverX] = useState(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);

  const w = Math.max(6, clipDur(clip) * pps);
  const thumbs = clip.frames || [];
  const count  = Math.max(1, Math.floor(w / 80));

  // How far into the source to start showing thumbnails
  const thumbStartRatio = clip.duration > 0 ? clip.inPoint / clip.duration : 0;
  const thumbEndRatio   = clip.duration > 0 ? clip.outPoint / clip.duration : 1;

  const startBodyDrag = e => {
    if (tool !== "select") return;
    e.preventDefault(); e.stopPropagation();
    onSelect();
    const startX  = e.clientX;
    const origSt  = clip.startTime;
    let moved = false;

    const onMove = ev => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 3) { moved = true; setDragging(true); }
      if (moved) onMove(clip.id, clamp(origSt + dx/pps, 0, Infinity), false);
    };
    const onUp = ev => {
      const dx = ev.clientX - startX;
      if (moved) onMove(clip.id, clamp(origSt + dx/pps, 0, Infinity), true);
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  };

  const handleClick = e => {
    if (tool === "cut") {
      const rect = e.currentTarget.getBoundingClientRect();
      const t = (e.clientX - rect.left) / w * clipDur(clip);
      onCut(clip.id, t);
    }
  };

  return (
    <div
      className={`vclip${isActive?" vclip--active":""}${tool==="cut"?" vclip--cut":""}${dragging?" vclip--dragging":""}`}
      style={{width:w,"--cc":clip.color}}
      onMouseDown={startBodyDrag}
      onClick={handleClick}
      onContextMenu={e=>{e.preventDefault();onCtxMenu(e,clip.id);}}
      onMouseMove={e=>{if(tool==="cut"){const r=e.currentTarget.getBoundingClientRect();setHoverX(e.clientX-r.left);}}}
      onMouseLeave={()=>setHoverX(null)}
      title={`${clip.name} · ${fmtSecs(clipDur(clip))} · ${fmtBytes(clip.size)}`}
    >
      {/* filmstrip — shows thumbnails for the trimmed range */}
      {thumbs.length > 0 ? (
        <div className="filmstrip">
          {Array.from({length:count},(_,i)=>{
            const ratio  = thumbStartRatio + (i/(count-1||1)) * (thumbEndRatio - thumbStartRatio);
            const fi     = Math.round(ratio * (thumbs.length-1));
            return <img key={i} src={thumbs[clamp(fi,0,thumbs.length-1)]} className="filmstrip__img" style={{width:w/count}} draggable={false} alt="" />;
          })}
        </div>
      ) : (
        <div className="vclip__loading"><span className="vclip__spinner"/> processing…</div>
      )}

      {/* clip name */}
      {w > 60 && <div className="vclip__label">{clip.name.replace(/\.[^.]+$/,"")}</div>}

      {/* upload bar */}
      {clip.uploadStatus==="uploading" && <div className="vclip__prog" style={{width:`${clip.uploadProgress}%`}}/>}
      {clip.uploadStatus==="done"      && <div className="vclip__tick">✓</div>}

      {/* trim handles */}
      {isActive && tool==="select" && (
        <>
          <TrimHandle side="left"
            onTrim={(dx, commit) => onTrimL(clip.id, dx/pps, commit)} />
          <TrimHandle side="right"
            onTrim={(dx, commit) => onTrimR(clip.id, dx/pps, commit)} />
        </>
      )}

      {/* cut mode indicator */}
      {tool==="cut" && hoverX!=null && (
        <div className="cut-indicator" style={{left:hoverX}}>
          <div className="cut-indicator__scissors">✂</div>
        </div>
      )}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AUDIO CLIP STRIP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function AudioClipStrip({ac, pps, isActive, linked, onSelect, onMove, onCtxMenu}){
  const w   = Math.max(4, clipDur(ac) * pps);
  const dragRef = useRef(null);

  const startDrag = e => {
    if (linked) return; // linked audio moves with video
    e.preventDefault(); e.stopPropagation();
    onSelect();
    const startX = e.clientX, origSt = ac.startTime;
    const mv = ev => onMove(ac.id, clamp(origSt+(ev.clientX-startX)/pps,0,Infinity), false);
    const up = ev => { onMove(ac.id, clamp(origSt+(ev.clientX-startX)/pps,0,Infinity), true); window.removeEventListener("mousemove",mv); window.removeEventListener("mouseup",up); };
    window.addEventListener("mousemove",mv); window.addEventListener("mouseup",up);
  };

  return (
    <div
      className={`audio-strip${isActive?" audio-strip--active":""}${linked?" audio-strip--linked":""}`}
      style={{width:w,"--ac":ac.color}}
      onMouseDown={startDrag}
      onClick={onSelect}
      onContextMenu={e=>{e.preventDefault();onCtxMenu(e,ac.id);}}
      title={`${ac.name} · ${fmtSecs(clipDur(ac))}${linked?" (linked)":""}`}
    >
      <div className="audio-strip__header">
        <span className="audio-strip__icon">{linked?"🔗":"♪"}</span>
        {w>80 && <span className="audio-strip__name">{ac.name.replace(/\.[^.]+$/,"")}</span>}
        {ac.muted && <span className="audio-strip__muted">M</span>}
      </div>
      <WaveCanvas data={ac.waveform} width={w} height={32} color={linked?"rgba(210,190,255,0.7)":"rgba(251,191,36,0.85)"}/>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DIMENSIONS TAB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function DimensionsTab({project,onChange}){
  const dim=project.dimension;
  const [cw,setCw]=useState(project.customW||1920);
  const [ch,setCh]=useState(project.customH||1080);
  const apply=d=>{ if(d.label==="Custom") onChange({dimension:d,customW:cw,customH:ch}); else onChange({dimension:d}); };
  return(
    <div className="dim-tab">
      <div className="dim-grid">
        {DIMS.map(d=>(
          <button key={d.label} className={`dim-card${dim.label===d.label?" dim-card--on":""}`} onClick={()=>apply(d)}>
            <div className="dim-card__ratio" style={{aspectRatio:`${d.w}/${d.h}`}}><div className="dim-card__inner"/></div>
            <div className="dim-card__label">{d.label}</div>
            <div className="dim-card__desc">{d.desc}</div>
          </button>
        ))}
      </div>
      {dim.label==="Custom"&&(
        <div className="dim-custom">
          <div className="dim-custom__row"><label>W</label><input type="number" value={cw} min={100} max={7680} onChange={e=>setCw(parseInt(e.target.value)||1920)} onBlur={()=>onChange({dimension:dim,customW:cw,customH:ch})}/><span>px</span></div>
          <div className="dim-sep">×</div>
          <div className="dim-custom__row"><label>H</label><input type="number" value={ch} min={100} max={4320} onChange={e=>setCh(parseInt(e.target.value)||1080)} onBlur={()=>onChange({dimension:dim,customW:cw,customH:ch})}/><span>px</span></div>
          <button className="dim-apply" onClick={()=>onChange({dimension:dim,customW:cw,customH:ch})}>Apply</button>
        </div>
      )}
      <div className="dim-current">
        Current: <strong>{dim.label==="Custom"?`${project.customW||1920}×${project.customH||1080}`:dim.desc}</strong>
        <span className="dim-px">{dim.label==="Custom"?`${project.customW||1920}×${project.customH||1080} px`:`${dim.w}×${dim.h} px`}</span>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INFO TAB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function InfoTab({clip}){
  if(!clip) return(
    <div className="tab-empty">
      <div className="tab-empty__icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.259a1 1 0 01-1.447.894L15 14"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg></div>
      Select a clip on the timeline
    </div>
  );
  const rows=[
    ["filename",    clip.name],
    ["size",        fmtBytes(clip.size)],
    ["duration",    clip.duration?fmtSecs(clip.duration):"—"],
    ["in / out",    `${fmtSecs(clip.inPoint)} → ${fmtSecs(clip.outPoint)}`],
    ["session_id",  clip.sessionId||"—"],
    ["chunk_size",  `${CHUNK_SIZE.toLocaleString()} B`],
    ["chunks",      clip.uploadExpectedChunks||"—"],
    ["status",      clip.uploadStatus||"local"],
  ];
  return(
    <div className="info-tab">
      {rows.map(([k,v])=>(
        <div className="info-row" key={k}>
          <span className="info-key">{k}</span>
          <span className={`info-val${k==="status"?` status--${clip.uploadStatus}`:""}`}>{String(v)}</span>
        </div>
      ))}
      {clip.uploadStatus==="uploading"&&(
        <div className="info-prog">
          <div className="info-prog__bar"><div className="info-prog__fill" style={{width:`${clip.uploadProgress}%`}}/></div>
          <span className="info-prog__label">chunk {clip.uploadChunk}/{clip.uploadExpectedChunks} — {clip.uploadProgress}%</span>
        </div>
      )}
      {clip.uploadError&&<div className="info-error">{clip.uploadError}</div>}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AI TAB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function AITab({onFile}){
  const [over,setOver]=useState(false);
  return(
    <div className="ai-tab">
      <div className="ai-tab__head"><span className="ai-star">✦</span> AI video edit</div>
      <p className="ai-tab__body">Drop a video to run scene detection, Whisper transcription, mood tagging, and smart assembly.</p>
      <div className="ai-toggle-row"><span>Review while editing</span><div className="toggle"><div className="toggle__dot"/></div></div>
      <div className={`ai-drop${over?" ai-drop--over":""}`}
        onClick={()=>{const i=document.createElement("input");i.type="file";i.accept="video/*";i.onchange=e=>[...e.target.files].forEach(onFile);i.click();}}
        onDragOver={e=>{e.preventDefault();setOver(true);}}
        onDragLeave={()=>setOver(false)}
        onDrop={e=>{e.preventDefault();e.stopPropagation();setOver(false);[...e.dataTransfer.files].filter(f=>f.type.startsWith("video/")).forEach(onFile);}}>
        <span className="ai-drop__plus">+</span>
        <span className="ai-drop__text"><strong>Drag and drop</strong> the video</span>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EXPORT MODAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function ExportModal({project, onClose}){
  const [mode,    setMode]    = useState("local");   // local | server
  const [quality, setQuality] = useState("high");
  const [maxDur,  setMaxDur]  = useState(0);
  const [status,  setStatus]  = useState("idle");
  const [progress,setProgress]= useState(0);
  const [dlUrl,   setDlUrl]   = useState(null);
  const [errMsg,  setErrMsg]  = useState("");
  const abortRef = useRef(null);
  const pollRef  = useRef(null);
  const dim      = project.dimension;
  const dimStr   = dim.label==="Custom"?`${project.customW||1920}:${project.customH||1080}`:dim.label;
  const uploadedClips = project.clips.filter(c=>c.uploadStatus==="done");

  const startLocal = async () => {
    setStatus("exporting"); setProgress(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const url = await localExport(project, setProgress, ctrl.signal);
      setDlUrl(url); setStatus("done");
    } catch(e) {
      if(!ctrl.signal.aborted){ setStatus("error"); setErrMsg(e.message); }
    }
  };

  const startServer = async () => {
    if(!uploadedClips.length){ setStatus("error"); setErrMsg("No uploaded clips."); return; }
    setStatus("exporting"); setProgress(5);
    try {
      const body={
        clip_ids:    uploadedClips.map(c=>c.id),
        in_points:   Object.fromEntries(uploadedClips.map(c=>[c.id,c.inPoint])),
        out_points:  Object.fromEntries(uploadedClips.map(c=>[c.id,c.outPoint])),
        format:      dimStr, max_duration:maxDur,
        crf:         {high:18,medium:23,low:28}[quality],
      };
      const {job_id}=await apiExport(body);
      pollRef.current=setInterval(async()=>{
        const d=await apiJobStatus(job_id);
        setProgress(d.progress||0);
        if(d.status==="done"){ clearInterval(pollRef.current); setStatus("done"); setDlUrl(`${API}/api/export/${job_id}/download`); }
        else if(d.status==="error"){ clearInterval(pollRef.current); setStatus("error"); setErrMsg(d.error||"Export failed"); }
      },1200);
    } catch(e){ setStatus("error"); setErrMsg(e.message); }
  };

  const start = () => mode==="local" ? startLocal() : startServer();
  const cancel = () => { abortRef.current?.abort(); clearInterval(pollRef.current); onClose(); };

  useEffect(()=>()=>{ abortRef.current?.abort(); clearInterval(pollRef.current); },[]);

  return(
    <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)cancel();}}>
      <div className="modal">
        <div className="modal__head"><span className="modal__title">Export</span><button className="modal__close" onClick={cancel}>✕</button></div>
        <div className="modal__body">
          <div className="export-mode-row">
            <button className={`export-mode-btn${mode==="local"?" export-mode-btn--on":""}`} onClick={()=>setMode("local")}>
              <span className="export-mode-icon">💾</span><span>Local (WebM)</span><span className="export-mode-sub">No server needed</span>
            </button>
            <button className={`export-mode-btn${mode==="server"?" export-mode-btn--on":""}`} onClick={()=>setMode("server")}>
              <span className="export-mode-icon">☁</span><span>Server (MP4)</span><span className="export-mode-sub">{uploadedClips.length}/{project.clips.length} clips ready</span>
            </button>
          </div>

          <div className="export-info-row"><span className="export-info__label">Dimension</span><span className="export-info__val">{dimStr} — {dim.label==="Custom"?`${project.customW||1920}×${project.customH||1080}`:`${dim.w}×${dim.h}`} px</span></div>

          {mode==="server"&&(
            <>
              <div className="export-field"><div className="export-field__label">Quality</div>
                <div className="export-pills">{["high","medium","low"].map(q=><button key={q} className={`export-pill${quality===q?" export-pill--on":""}`} onClick={()=>setQuality(q)}>{q}</button>)}</div>
              </div>
              <div className="export-field"><div className="export-field__label">Max duration</div>
                <div className="export-pills">{[0,30,60,90,180].map(d=><button key={d} className={`export-pill${maxDur===d?" export-pill--on":""}`} onClick={()=>setMaxDur(d)}>{d===0?"Full":`${d}s`}</button>)}</div>
              </div>
            </>
          )}

          {status==="exporting"&&<div className="export-prog"><div className="export-prog__bar"><div className="export-prog__fill" style={{width:`${progress}%`}}/></div><span className="export-prog__label">{progress}%</span></div>}
          {status==="error"   &&<div className="export-err">{errMsg}</div>}
          {status==="done"    &&<div className="export-done"><span>✓ Done</span><a href={dlUrl} download="clipmind_export" className="export-dl">↓ Download</a></div>}

          {mode==="local"&&status==="idle"&&<div className="export-note">Exports in real-time using your browser. Output is WebM video (compatible with all modern players and Chrome/Firefox).</div>}
        </div>
        <div className="modal__foot">
          <button className="btn-cancel" onClick={cancel}>Cancel</button>
          <button className="btn-export-go" onClick={start} disabled={status==="exporting"||status==="done"}>{status==="exporting"?"Exporting…":"Export"}</button>
        </div>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CONTEXT MENU
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function CtxMenu({x,y,clipId,audioId,onDelete,onCutAtPlayhead,onDetachAudio,onClose}){
  useEffect(()=>{ const h=()=>onClose(); window.addEventListener("click",h,{once:true}); return()=>window.removeEventListener("click",h); },[onClose]);
  return(
    <div className="ctxmenu" style={{left:x,top:y}}>
      {clipId&&<><button className="ctxmenu__item" onClick={()=>{onCutAtPlayhead(clipId);onClose();}}>✂ Split at playhead</button>
        <button className="ctxmenu__item" onClick={()=>{onDetachAudio(clipId);onClose();}}>🔊 Detach audio</button>
        <div className="ctxmenu__sep"/>
        <button className="ctxmenu__item ctxmenu__item--danger" onClick={()=>{onDelete("clip",clipId);onClose();}}>🗑 Delete clip</button></>}
      {audioId&&<><button className="ctxmenu__item" onClick={()=>{onDetachAudio(null,audioId);onClose();}}>🔗 Toggle link</button>
        <div className="ctxmenu__sep"/>
        <button className="ctxmenu__item ctxmenu__item--danger" onClick={()=>{onDelete("audio",audioId);onClose();}}>🗑 Delete audio</button></>}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TOAST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function Toast({toast,onClose}){
  useEffect(()=>{ const t=setTimeout(onClose,7000); return()=>clearTimeout(t); },[onClose]);
  return(
    <div className={`toast toast--${toast.type}`}>
      <div className="toast__head">
        <span className="toast__icon">{toast.type==="ok"?"↑":"!"}</span>
        <span className="toast__title">{toast.type==="ok"?`Saved — ${toast.filename}`:"Error"}</span>
        <button className="toast__close" onClick={onClose}>✕</button>
      </div>
      {toast.type==="ok"&&<pre className="toast__code">{JSON.stringify(toast.payload,null,2)}</pre>}
      {toast.type==="error"&&<div className="toast__msg">{toast.message}</div>}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ROOT APP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export default function App(){
  // ── project state + undo / redo ──
  const [projects, setProjects] = useState([mkProject("Project 1")]);
  const [activePId, setActivePId] = useState(null); // set after load
  const [past,   setPast]   = useState([]);
  const [future, setFuture] = useState([]);

  const [tool,       setTool]       = useState("select");
  const [showExport, setShowExport] = useState(false);
  const [toast,      setToast]      = useState(null);
  const [ctxMenu,    setCtxMenu]    = useState(null);
  const [dropZone,   setDropZone]   = useState(false);
  const [rpTab,      setRpTab]      = useState("info");
  const [loaded,     setLoaded]     = useState(false);

  const fileInputRef = useRef();
  const videoRef     = useRef();
  const tlRef        = useRef();

  // ── active project ──
  const proj = useMemo(()=>projects.find(p=>p.id===activePId)||projects[0],[projects,activePId]);

  // ── snapshot (call before any destructive mutation) ──
  const snap = useCallback(() => {
    setPast(p => [...p.slice(-(MAX_HIST-1)), projects]);
    setFuture([]);
  }, [projects]);

  const undo = useCallback(()=>{
    if(!past.length) return;
    setFuture(f=>[projects,...f.slice(0,MAX_HIST-1)]);
    setProjects(past[past.length-1]);
    setPast(p=>p.slice(0,-1));
  },[past,projects]);

  const redo = useCallback(()=>{
    if(!future.length) return;
    setPast(p=>[...p,projects]);
    setProjects(future[0]);
    setFuture(f=>f.slice(1));
  },[future,projects]);

  // ── update helpers ──
  const updProj = useCallback(patch => setProjects(prev =>
    prev.map(p => p.id===(activePId||prev[0]?.id) ? {...p,...(typeof patch==="function"?patch(p):patch)} : p)
  ),[activePId]);

  const updClip = (id,patch) => setProjects(prev=>prev.map(p=>
    p.id!==activePId?p:{...p,clips:p.clips.map(c=>c.id===id?{...c,...patch}:c)}
  ));
  const updAudioClip = (id,patch) => setProjects(prev=>prev.map(p=>
    p.id!==activePId?p:{...p,audioClips:p.audioClips.map(a=>a.id===id?{...a,...patch}:a)}
  ));

  const clips      = proj?.clips||[];
  const audioClips = proj?.audioClips||[];
  const selClip    = clips.find(c=>c.id===proj?.selectedId)||null;
  const totalDur   = Math.max(60, clips.reduce((m,c)=>Math.max(m,c.startTime+clipDur(c)),0)+4);
  const dim        = proj?.dimension||DIMS[0];
  const dimW       = dim.label==="Custom"?proj?.customW||1920:dim.w;
  const dimH       = dim.label==="Custom"?proj?.customH||1080:dim.h;

  // ── LOAD FROM INDEXEDDB on mount ──
  useEffect(()=>{
    (async()=>{
      const saved = await DB.loadProjects();
      if(saved?.length){
        // Restore objectUrls from IndexedDB blobs
        const restored = await Promise.all(saved.map(async p=>({
          ...p,
          clips: await Promise.all(p.clips.map(async c=>{
            try{
              const blob = await DB.loadBlob(c.id);
              if(blob){ const url=URL.createObjectURL(blob); return {...c,objectUrl:url}; }
            }catch{}
            return c; // no blob found, keep as-is
          })),
        })));
        setProjects(restored);
        setActivePId(restored[0]?.id);
      } else {
        const init = mkProject("Project 1");
        setProjects([init]);
        setActivePId(init.id);
      }
      setLoaded(true);
    })();
  },[]);

  // ── SAVE TO INDEXEDDB whenever projects change ──
  useEffect(()=>{
    if(!loaded) return;
    DB.saveProjects(projects).catch(()=>{});
  },[projects,loaded]);

  // ── video sync ──
  useEffect(()=>{
    if(!videoRef.current||!selClip)return;
    videoRef.current.src=selClip.objectUrl||"";
    videoRef.current.load();
  },[selClip?.id]); // eslint-disable-line

  useEffect(()=>{
    const v=videoRef.current; if(!v||!selClip)return;
    const onUpdate=()=>updProj({currentTime:selClip.startTime+v.currentTime});
    const onEnded =()=>updProj({isPlaying:false});
    v.addEventListener("timeupdate",onUpdate); v.addEventListener("ended",onEnded);
    return()=>{ v.removeEventListener("timeupdate",onUpdate); v.removeEventListener("ended",onEnded); };
  },[selClip?.id]); // eslint-disable-line

  // ── seek ──
  const seek = useCallback((t)=>{
    const ct = clamp(t,0,totalDur);
    updProj({currentTime:ct});
    if(videoRef.current&&selClip){
      const local=ct-selClip.startTime;
      if(local>=0&&local<=selClip.duration) videoRef.current.currentTime=local;
    }
  },[selClip,totalDur,updProj]);

  const togglePlay = useCallback(()=>{
    const v=videoRef.current; if(!v||!selClip)return;
    if(proj.isPlaying){v.pause();updProj({isPlaying:false});}
    else{v.play().catch(()=>{});updProj({isPlaying:true});}
  },[selClip,proj?.isPlaying,updProj]);

  // ── MOVE CLIP ──
  const moveClip = useCallback((id, newStartTime, commit) => {
    if(commit) snap();
    updClip(id,{startTime:newStartTime});
    // also move linked audio
    setProjects(prev=>prev.map(p=>{
      if(p.id!==activePId)return p;
      return{...p,audioClips:p.audioClips.map(a=>a.videoClipId===id&&a.linked?{...a,startTime:newStartTime}:a)};
    }));
  },[activePId,snap,updClip]);

  // ── TRIM LEFT (in point + start time) ──
  const trimLeft = useCallback((id, dt, commit)=>{
    if(commit) snap();
    setProjects(prev=>prev.map(p=>{
      if(p.id!==activePId)return p;
      const c=p.clips.find(x=>x.id===id); if(!c)return p;
      const maxIn  = c.outPoint-0.2;
      const newIn  = clamp(c.inPoint+dt, 0, maxIn);
      const diff   = newIn - c.inPoint;
      return{...p,clips:p.clips.map(x=>x.id===id?{...x,inPoint:newIn,startTime:x.startTime+diff}:x)};
    }));
  },[activePId,snap]);

  // ── TRIM RIGHT (out point) ──
  const trimRight = useCallback((id, dt, commit)=>{
    if(commit) snap();
    setProjects(prev=>prev.map(p=>{
      if(p.id!==activePId)return p;
      const c=p.clips.find(x=>x.id===id); if(!c)return p;
      const minOut = c.inPoint+0.2;
      const newOut = clamp(c.outPoint+dt, minOut, c.duration);
      return{...p,clips:p.clips.map(x=>x.id===id?{...x,outPoint:newOut}:x)};
    }));
  },[activePId,snap]);

  // ── DELETE ──
  const deleteItem = useCallback((type,id)=>{
    snap();
    setProjects(prev=>prev.map(p=>{
      if(p.id!==activePId)return p;
      if(type==="clip"){
        const filtered=p.clips.filter(c=>c.id!==id);
        let t=0; const packed=filtered.map(c=>{const nc={...c,startTime:t};t+=clipDur(c);return nc;});
        const filteredAudio=p.audioClips.filter(a=>a.videoClipId!==id);
        return{...p,clips:packed,audioClips:filteredAudio,selectedId:null};
      }
      if(type==="audio") return{...p,audioClips:p.audioClips.filter(a=>a.id!==id),selectedAudioId:null};
      return p;
    }));
    DB.deleteBlob(id).catch(()=>{});
  },[activePId,snap]);

  // ── CUT ──
  const cutClip = useCallback((clipId, relTime)=>{
    snap();
    setProjects(prev=>prev.map(p=>{
      if(p.id!==activePId)return p;
      const clip=p.clips.find(c=>c.id===clipId); if(!clip)return p;
      const offset=relTime!=null?relTime:(p.currentTime-clip.startTime);
      if(offset<0.1||offset>clipDur(clip)-0.1)return p;
      const sf=Math.floor((offset/clipDur(clip))*(clip.frames?.length||0));
      const sw=Math.floor((offset/clipDur(clip))*(clip.waveform?.length||0));
      const A={...clip,id:uid(),duration:clip.duration,outPoint:clip.inPoint+offset,
        frames:clip.frames?.slice(0,Math.max(1,sf)),waveform:clip.waveform?.slice(0,sw)};
      const B={...clip,id:uid(),startTime:clip.startTime+offset,inPoint:clip.inPoint+offset,
        frames:clip.frames?.slice(sf),waveform:clip.waveform?.slice(sw)};
      const idx=p.clips.findIndex(c=>c.id===clipId);
      const newClips=[...p.clips]; newClips.splice(idx,1,A,B);
      return{...p,clips:newClips};
    }));
  },[activePId,snap]);

  // ── DETACH AUDIO ──
  const detachAudio = useCallback((clipId, audioId)=>{
    snap();
    if(audioId){
      // toggle link on existing audio strip
      updAudioClip(audioId,{linked:prev=>!prev});
      return;
    }
    // detach from video clip
    setProjects(prev=>prev.map(p=>{
      if(p.id!==activePId)return p;
      const existing=p.audioClips.find(a=>a.videoClipId===clipId);
      if(existing) return{...p,audioClips:p.audioClips.map(a=>a.videoClipId===clipId?{...a,linked:!a.linked}:a)};
      return p; // no audio strip yet (waveform not extracted)
    }));
  },[activePId,snap,updAudioClip]);

  // ── MOVE AUDIO CLIP ──
  const moveAudioClip = useCallback((id, t, commit)=>{
    if(commit) snap();
    updAudioClip(id,{startTime:t});
  },[snap,updAudioClip]);

  // ── PROCESS FILE ──
  const processFile = useCallback(async file=>{
    if(!file.type.startsWith("video/"))return;
    const sessionId = uid();
    const objectUrl = URL.createObjectURL(file);

    const duration = await new Promise(res=>{
      const v=document.createElement("video"); v.preload="metadata";
      v.onloadedmetadata=()=>res(v.duration); v.onerror=()=>res(0); v.src=objectUrl;
    });

    let clipId;
    const pidNow = activePId || projects[0]?.id;
    setProjects(prev=>prev.map(p=>{
      if(p.id!==pidNow)return p;
      clipId=uid();
      const startTime=p.clips.reduce((m,c)=>Math.max(m,c.startTime+clipDur(c)),0);
      return{...p,
        clips:[...p.clips,{
          id:clipId, file, name:file.name, size:file.size,
          duration, objectUrl, frames:[], waveform:[],
          color:PALETTE[p.clips.length%PALETTE.length],
          startTime, inPoint:0, outPoint:duration,
          sessionId,
          uploadStatus:"uploading", uploadProgress:0, uploadChunk:0,
          uploadExpectedChunks:Math.ceil(file.size/CHUNK_SIZE), uploadError:null,
        }],
        selectedId:clipId,
      };
    }));

    // save blob to IndexedDB
    DB.saveBlob(clipId, file).catch(()=>{});

    await new Promise(r=>setTimeout(r,50));

    // upload to server
    try{
      const{payload,expectedChunks}=await apiInit(file,sessionId);
      setToast({type:"ok",filename:file.name,payload});
      for(let i=0;i<expectedChunks;i++){
        const blob=file.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE);
        try{await apiChunk(sessionId,i,blob);}catch{}
        updClip(clipId,{uploadChunk:i+1,uploadProgress:Math.round(((i+1)/expectedChunks)*100)});
      }
      updClip(clipId,{uploadStatus:"done",uploadProgress:100});
    }catch(e){
      updClip(clipId,{uploadStatus:"local",uploadProgress:0,uploadError:e.message});
    }

    // extract frames + waveform
    const[frames,waveform]=await Promise.all([extractFrames(objectUrl,22),extractWaveform(file,160)]);
    updClip(clipId,{frames,waveform});

    // create audio strip
    setProjects(prev=>prev.map(p=>{
      if(p.id!==pidNow)return p;
      const c=p.clips.find(x=>x.id===clipId); if(!c)return p;
      const aId=uid();
      return{...p,audioClips:[...p.audioClips,{
        id:aId, videoClipId:clipId, name:file.name,
        startTime:c.startTime, inPoint:0, outPoint:duration,
        waveform, linked:true, muted:false, volume:1,
        color:c.color,
      }]};
    }));
  },[activePId,projects]); // eslint-disable-line

  // ── KEYBOARD ──
  useEffect(()=>{
    const onKey=e=>{
      const tag=document.activeElement?.tagName;
      if(tag==="INPUT"||tag==="TEXTAREA")return;
      if(e.key===" "){ e.preventDefault(); togglePlay(); }
      if(e.key==="v"||e.key==="V") setTool("select");
      if(e.key==="c"||e.key==="C") setTool("cut");
      if((e.key==="Delete"||e.key==="Backspace")&&proj?.selectedId) deleteItem("clip",proj.selectedId);
      if((e.key==="s"||e.key==="S")&&proj?.selectedId){
        const c=proj.clips.find(x=>x.id===proj.selectedId);
        if(c) cutClip(c.id, proj.currentTime-c.startTime);
      }
      if((e.metaKey||e.ctrlKey)&&e.key==="z"&&!e.shiftKey){ e.preventDefault(); undo(); }
      if((e.metaKey||e.ctrlKey)&&(e.key==="y"||(e.key==="z"&&e.shiftKey))){ e.preventDefault(); redo(); }
      if(e.key==="+"||e.key==="=") updProj({zoom:Math.min(400,(proj?.zoom||80)+20)});
      if(e.key==="-")               updProj({zoom:Math.max(20,(proj?.zoom||80)-20)});
    };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[proj,togglePlay,deleteItem,cutClip,undo,redo,updProj]);

  // ── WHEEL ZOOM ──
  const onTlWheel = useCallback(e=>{
    if(e.ctrlKey||e.metaKey){
      e.preventDefault();
      updProj({zoom:Math.max(20,Math.min(400,(proj?.zoom||80)+(e.deltaY>0?-15:15)))});
    }
  },[proj?.zoom,updProj]);

  // ── RULER SCRUB ──
  const onRulerDown = e=>{
    if(e.target.closest(".ruler-mark"))return;
    const tl=tlRef.current;
    const hit=ev=>{const x=ev.clientX-tl.getBoundingClientRect().left+tl.scrollLeft;seek(x/(proj?.zoom||80));};
    hit(e);
    const mv=ev=>hit(ev);
    const up=()=>{ window.removeEventListener("mousemove",mv); window.removeEventListener("mouseup",up); };
    window.addEventListener("mousemove",mv); window.addEventListener("mouseup",up);
  };

  // ── PROJECTS ──
  const newProject = ()=>{ const p=mkProject(`Project ${projects.length+1}`); setProjects(ps=>[...ps,p]); setActivePId(p.id); };
  const closeProject = id=>{ if(projects.length===1)return; const r=projects.filter(p=>p.id!==id); setProjects(r); if(activePId===id)setActivePId(r[r.length-1].id); };
  const renameProject = (id,name)=>setProjects(ps=>ps.map(p=>p.id===id?{...p,name}:p));

  // ── RULER ──
  const zoom   = proj?.zoom||80;
  const step   = zoom>=100?5:zoom>=50?10:30;
  const totalPx= Math.ceil(totalDur)*zoom+300;
  const marks  = Array.from({length:Math.ceil(totalDur/step)+1},(_,i)=>i*step);

  if(!loaded) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#080808",color:"#555",fontFamily:"monospace"}}>Loading…</div>;

  return(
    <div className={`editor${dropZone?" editor--drop":""}`}
      onDragOver={e=>{e.preventDefault();setDropZone(true);}}
      onDragLeave={()=>setDropZone(false)}
      onDrop={e=>{e.preventDefault();setDropZone(false);[...e.dataTransfer.files].forEach(processFile);}}>

      <input ref={fileInputRef} type="file" multiple accept="video/*" style={{display:"none"}}
        onChange={e=>{[...e.target.files].forEach(processFile);e.target.value="";}}/>

      {/* ══ HEADER ══ */}
      <header className="header">
        <button className="btn-new" onClick={()=>fileInputRef.current.click()}><span className="btn-new__plus">+</span> New upload</button>

        <div className="proj-tabs">
          {projects.map(p=>(
            <div key={p.id} className={`proj-tab${p.id===activePId?" proj-tab--on":""}`} onClick={()=>setActivePId(p.id)}>
              <span className="proj-tab__name" contentEditable suppressContentEditableWarning
                onBlur={e=>renameProject(p.id,e.target.textContent.trim()||"Untitled")}
                onClick={e=>e.stopPropagation()}>{p.name}</span>
              {projects.length>1&&<button className="proj-tab__close" onClick={e=>{e.stopPropagation();closeProject(p.id);}}>×</button>}
            </div>
          ))}
          <button className="proj-tab-new" onClick={newProject} title="New project">+</button>
        </div>

        <div className="toolbar">
          <button className={`tool-btn${tool==="select"?" tool-btn--on":""}`} onClick={()=>setTool("select")} title="Select (V)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M4 0l16 12-7 1-4 8z"/></svg>
          </button>
          <button className={`tool-btn${tool==="cut"?" tool-btn--on":""}`} onClick={()=>setTool("cut")} title="Cut (C)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/></svg>
          </button>
          <div className="tool-sep"/>
          <button className="tool-btn" onClick={()=>{if(proj?.selectedId)deleteItem("clip",proj.selectedId);}} title="Delete (Del)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          </button>
          <button className="tool-btn" onClick={()=>{const c=selClip;if(c)cutClip(c.id,proj.currentTime-c.startTime);}} title="Split at playhead (S)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/></svg>
          </button>
          <div className="tool-sep"/>
          <button className="tool-btn" onClick={undo} title="Undo (Cmd+Z)" disabled={!past.length}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 14L4 9l5-5M4 9h11a6 6 0 010 12h-1"/></svg>
          </button>
          <button className="tool-btn" onClick={redo} title="Redo (Cmd+Shift+Z)" disabled={!future.length}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 14l5-5-5-5M19 9H8a6 6 0 000 12h1"/></svg>
          </button>
        </div>

        <div style={{flex:1}}/>
        <button className="btn-export-hdr" onClick={()=>setShowExport(true)}>↑ Export</button>
        <div className="header-personalize">Personalization <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></div>
      </header>

      {/* ══ MAIN ══ */}
      <div className="main">
        {/* preview */}
        <div className="preview">
          <div className="video-stage">
            <div className="dim-frame" style={{aspectRatio:`${dimW}/${dimH}`}}>
              {selClip
                ?<video ref={videoRef} className="video-el" playsInline style={{objectFit:"cover"}}/>
                :<div className="video-empty" onClick={()=>fileInputRef.current.click()}>
                  <div className="video-empty__circle"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.259a1 1 0 01-1.447.894L15 14"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg></div>
                  <p>Drop video or click New upload</p>
                </div>
              }
              <div className="dim-badge">{dim.label==="Custom"?`${dimW}×${dimH}`:dim.label}</div>
            </div>
          </div>
          <div className="controls">
            <span className="timecode">{fmtSecs(proj?.currentTime||0)}</span>
            <div className="ctrl-group">
              <button className="ctrl" onClick={()=>seek((proj?.currentTime||0)-15)}>⟨15</button>
              <button className="ctrl" onClick={()=>seek((proj?.currentTime||0)-1)}>‹</button>
              <button className="ctrl ctrl--play" onClick={togglePlay}>
                {proj?.isPlaying
                  ?<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                  :<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
              </button>
              <button className="ctrl" onClick={()=>seek((proj?.currentTime||0)+1)}>›</button>
              <button className="ctrl" onClick={()=>seek((proj?.currentTime||0)+15)}>15⟩</button>
            </div>
            <div className="ctrl-right">
              <span className="timecode">{selClip?fmtSecs(clipDur(selClip)):"00:00"}</span>
              <div className="aspect-pill" onClick={()=>setRpTab("dimensions")}>{dim.label} ▾</div>
            </div>
          </div>
        </div>

        {/* right panel */}
        <aside className="rp">
          <div className="rp__tabs">
            {["info","dimensions","ai video","audio"].map(t=>(
              <button key={t} className={`rp__tab${rpTab===t?" rp__tab--on":""}`} onClick={()=>setRpTab(t)}>{t}</button>
            ))}
          </div>
          <div className="rp__body">
            {rpTab==="info"       && <InfoTab clip={selClip}/>}
            {rpTab==="dimensions" && <DimensionsTab project={proj} onChange={updProj}/>}
            {rpTab==="ai video"   && <AITab onFile={processFile}/>}
            {rpTab==="audio"      && <div className="tab-empty">Audio settings coming soon</div>}
          </div>
        </aside>
      </div>

      {/* ══ TIMELINE ══ */}
      <div className="tl-shell">
        <div className="tl-bar">
          <span className="tl-bar__label">{clips.length} clip{clips.length!==1?"s":""} · {fmtSecs(proj?.currentTime||0)}</span>
          <div className="tl-tools-hint">
            {tool==="cut"
              ?<span className="tool-hint tool-hint--cut">✂ Click clip to split · drag blade to position</span>
              :<span className="tool-hint">V=select  C=cut  S=split  Del=delete  ⌘Z=undo  ⌘⇧Z=redo  Ctrl+scroll=zoom</span>}
          </div>
          <div className="tl-zoom">
            <button className="zoom-btn" onClick={()=>updProj({zoom:Math.max(20,zoom-20)})}>−</button>
            <input type="range" className="zoom-slider" min={20} max={300} value={zoom} onChange={e=>updProj({zoom:parseInt(e.target.value)})}/>
            <button className="zoom-btn" onClick={()=>updProj({zoom:Math.min(300,zoom+20)})}>+</button>
            <span className="zoom-val">{zoom}px/s</span>
          </div>
        </div>

        <div className="tl-scroll" ref={tlRef} onWheel={onTlWheel}>
          {/* ruler */}
          <div className="ruler" style={{width:totalPx}} onMouseDown={onRulerDown}>
            {marks.map(t=>(
              <div key={t} className="ruler-mark" style={{left:t*zoom}}>
                <span className="ruler-mark__label">{fmtRuler(t)}</span>
              </div>
            ))}
            <div className="playhead" style={{left:(proj?.currentTime||0)*zoom}}>
              <div className="playhead__head"/><div className="playhead__line"/>
            </div>
          </div>

          {/* VIDEO TRACK */}
          <div className="track-row">
            <div className="track-label-col"><span className="track-label-text">VIDEO</span></div>
            <div className="track" style={{width:totalPx}}>
              {clips.map(c=>(
                <div key={c.id} className="track__slot" style={{left:c.startTime*zoom}}>
                  <VideoClip clip={c} pps={zoom}
                    isActive={c.id===proj?.selectedId} tool={tool}
                    onSelect={()=>updProj({selectedId:c.id})}
                    onMove={moveClip}
                    onTrimL={trimLeft}
                    onTrimR={trimRight}
                    onCtxMenu={(e,id)=>setCtxMenu({x:e.clientX,y:e.clientY,clipId:id})}
                    onCut={cutClip}
                  />
                </div>
              ))}
              {clips.length===0&&<div className="track__empty">Drop clips here</div>}
            </div>
          </div>

          {/* AUDIO TRACK */}
          <div className="track-row">
            <div className="track-label-col"><span className="track-label-text">AUDIO</span></div>
            <div className="track track--audio" style={{width:totalPx}}>
              {audioClips.map(ac=>{
                const linkedClip = clips.find(c=>c.id===ac.videoClipId);
                const displayStart = ac.linked && linkedClip ? linkedClip.startTime : ac.startTime;
                return(
                  <div key={ac.id} className="track__slot" style={{left:displayStart*zoom}}>
                    <AudioClipStrip
                      ac={{...ac,startTime:displayStart}}
                      pps={zoom}
                      isActive={ac.id===proj?.selectedAudioId}
                      linked={ac.linked}
                      onSelect={()=>updProj({selectedAudioId:ac.id})}
                      onMove={moveAudioClip}
                      onCtxMenu={(e,id)=>setCtxMenu({x:e.clientX,y:e.clientY,audioId:id})}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="tl-statusbar">
          {proj?.selectedId&&<span>Selected · <kbd>S</kbd> split · <kbd>Del</kbd> delete · drag edges to trim · right-click for options</span>}
          {!proj?.selectedId&&<span>Click clip to select · <kbd>Space</kbd> play · <kbd>C</kbd> cut mode · <kbd>⌘Z</kbd> undo</span>}
        </div>
      </div>

      {/* ══ OVERLAYS ══ */}
      {ctxMenu&&(
        <CtxMenu x={ctxMenu.x} y={ctxMenu.y} clipId={ctxMenu.clipId} audioId={ctxMenu.audioId}
          onDelete={deleteItem}
          onCutAtPlayhead={id=>{cutClip(id,null);}}
          onDetachAudio={detachAudio}
          onClose={()=>setCtxMenu(null)}/>
      )}
      {showExport&&<ExportModal project={proj} onClose={()=>setShowExport(false)}/>}
      {toast&&<Toast toast={toast} onClose={()=>setToast(null)}/>}
      {dropZone&&(
        <div className="drop-overlay">
          <div className="drop-overlay__box">
            <div className="drop-overlay__icon">↑</div>
            <div className="drop-overlay__text">Drop video to add to timeline</div>
          </div>
        </div>
      )}
    </div>
  );
}