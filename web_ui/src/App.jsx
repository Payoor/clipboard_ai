import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createFFmpeg, fetchFile } from "@ffmpeg/ffmpeg";
import "./App.css";

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CONFIG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const API = "http://192.168.100.226";
const CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_HIST = 40;
const TRACK_H = 58;   // video track row px
const AUDIO_H = 52;   // audio track row px
const RULER_H = 26;
const SNAP_PX = 8;

const DIMS = [
  { label: "16:9", w: 1920, h: 1080, desc: "YouTube" },
  { label: "9:16", w: 1080, h: 1920, desc: "Reels" },
  { label: "1:1", w: 1080, h: 1080, desc: "Square" },
  { label: "4:5", w: 1080, h: 1350, desc: "Portrait" },
  { label: "4:3", w: 1440, h: 1080, desc: "Classic" },
  { label: "21:9", w: 2560, h: 1080, desc: "Cinema" },
  { label: "Custom", w: 1920, h: 1080, desc: "Custom" },
];

const FPS_OPTIONS = [24, 30, 60];
const FORMATS = ["mp4", "mov", "webm"];
const PALETTE = ["#4C3BCF", "#1A6B8A", "#6B2D82", "#1A6B51", "#8A2D2D", "#2D4A8A", "#7A4F1A", "#2D6B42"];
const FSA_OK = typeof window !== "undefined" && "showDirectoryPicker" in window;

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   FFMPEG SINGLETON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const ff = createFFmpeg({ corePath: "https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js", log: false });
let ffLoading = false;
const loadFF = async () => {
  if (ff.isLoaded()) return;
  if (ffLoading) { while (!ff.isLoaded()) await new Promise(r => setTimeout(r, 200)); return; }
  ffLoading = true; await ff.load(); ffLoading = false;
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SIMPLE IDB (only used for handle + tiny meta)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const IDB = (() => {
  let _db = null;
  const open = () => new Promise((res, rej) => {
    if (_db) { res(_db); return; }
    const req = indexedDB.open("clipmind_meta", 1);
    req.onupgradeneeded = e => { const d = e.target.result;["handles", "meta"].forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); }); };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
  const rw = (store, mode, fn) => new Promise((res, rej) => {
    open().then(db => { const t = db.transaction(store, mode); const r = fn(t.objectStore(store)); if (r) { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } else { t.oncomplete = () => res(); t.onerror = () => rej(t.error); } });
  });
  return {
    saveHandle: (k, v) => rw("handles", "readwrite", s => { s.put(v, k); }),
    loadHandle: k => rw("handles", "readonly", s => s.get(k)),
    saveMeta: (k, v) => rw("meta", "readwrite", s => { s.put(v, k); }),
    loadMeta: k => rw("meta", "readonly", s => s.get(k)),
  };
})();

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   FILE SYSTEM ACCESS API  (fast native I/O)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const FS = {
  async pickFolder() {
    const h = await window.showDirectoryPicker({ id: "clipmind", mode: "readwrite", startIn: "documents" });
    await IDB.saveHandle("projectDir", h);
    return h;
  },

  async getSavedFolder() {
    try {
      const h = await IDB.loadHandle("projectDir");
      if (!h) return null;
      const perm = await h.queryPermission({ mode: "readwrite" });
      if (perm === "granted") return h;
      const req = await h.requestPermission({ mode: "readwrite" });
      return req === "granted" ? h : null;
    } catch { return null; }
  },

  async writeFile(dirHandle, name, data) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data); await w.close();
  },

  async readFile(dirHandle, name) {
    const fh = await dirHandle.getFileHandle(name);
    return fh.getFile();
  },

  async saveProject(dirHandle, projects) {
    // 1. Write project.json (metadata only, no blobs)
    const serial = serializeProjects(projects);
    await this.writeFile(dirHandle, "project.json", JSON.stringify(serial, null, 2));

    // 2. Ensure clips/ subfolder and write any new video files
    let clipsDir;
    try { clipsDir = await dirHandle.getDirectoryHandle("clips", { create: true }); } catch { return; }

    for (const p of projects) {
      for (const c of p.clips) {
        if (!c.file) continue;
        const ext = c.name.match(/\.[^.]+$/)?.[0] || ".mp4";
        try { await this.writeFile(clipsDir, `${c.id}${ext}`, c.file); } catch { }
      }
    }
  },

  async loadProject(dirHandle) {
    const projFile = await this.readFile(dirHandle, "project.json");
    const serial = JSON.parse(await projFile.text());

    let clipsDir = null;
    try { clipsDir = await dirHandle.getDirectoryHandle("clips"); } catch { }

    const projects = await Promise.all(serial.projects.map(async p => ({
      ...p,
      clips: await Promise.all((p.clips || []).map(async c => {
        if (!clipsDir) return c;
        const ext = c.name.match(/\.[^.]+$/)?.[0] || ".mp4";
        try {
          const f = await (await clipsDir.getFileHandle(`${c.id}${ext}`)).getFile();
          return { ...c, file: f, objectUrl: URL.createObjectURL(f) };
        } catch { return c; }
      })),
    })));
    return projects;
  },

  downloadJSON(projects) {
    const blob = new Blob([JSON.stringify(serializeProjects(projects), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "clipmind_project.json";
    a.click();
  },
};

/* serialize: strip File objects + frames (large) for project.json */
const serializeProjects = ps => ({
  version: "1.1",
  savedAt: new Date().toISOString(),
  projects: ps.map(p => ({
    ...p,
    clips: p.clips.map(c => ({ ...c, file: undefined, objectUrl: undefined, frames: undefined })),
  })),
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   UTILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const fmtBytes = b => b >= 1073741824 ? `${(b / 1073741824).toFixed(2)}GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${(b / 1024).toFixed(0)}KB`;
const fmtSecs = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtRuler = s => `${String(Math.floor(s / 60)).padStart(2, "0")}.${String(Math.floor(s % 60)).padStart(2, "0")}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clipDur = c => Math.max(0, (c.outPoint || 0) - (c.inPoint || 0));
const getExt = n => n.match(/\.[^.]+$/)?.[0] || ".mp4";

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MEDIA EXTRACTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const extractFrames = (url, n = 22) => new Promise(res => {
  const v = document.createElement("video"), c = document.createElement("canvas");
  c.width = 80; c.height = 45; const ctx = c.getContext("2d"); let i = 0; const out = [];
  v.muted = true; v.playsInline = true;
  v.onloadedmetadata = () => {
    const step = v.duration / n;
    const next = () => { if (i >= n) { res(out); return; } v.currentTime = Math.min(step * i, v.duration - 0.05); };
    v.onseeked = () => { ctx.drawImage(v, 0, 0, 80, 45); out.push(c.toDataURL("image/jpeg", 0.6)); i++; next(); };
    next();
  };
  v.onerror = () => res([]); v.src = url;
});

const extractWaveform = async (file, samples = 160) => {
  try {
    const ab = await file.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ac.decodeAudioData(ab); await ac.close();
    const ch = buf.getChannelData(0); const blk = Math.floor(ch.length / samples);
    return Array.from({ length: samples }, (_, i) => { let pk = 0; for (let j = 0; j < blk; j++) { const v = Math.abs(ch[i * blk + j] || 0); if (v > pk) pk = v; } return pk; });
  } catch {
    return Array.from({ length: samples }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.18 + 1)) + Math.random() * 0.15);
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   UPLOAD API
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const apiInit = async (file, sid) => {
  const ec = Math.ceil(file.size / CHUNK_SIZE);
  const payload = { session_id: sid, chunk_size: CHUNK_SIZE, expected_chunks: ec, filename: file.name, file_size: file.size };
  const r = await fetch(`${API}/api/upload/init`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`Server ${r.status}`);
  return { payload, response: await r.json().catch(() => ({})), expectedChunks: ec };
};

const apiChunk = (sid, i, b) => { const fd = new FormData(); fd.append("session_id", sid); fd.append("chunk_index", String(i)); fd.append("chunk", b, `c${i}`); return fetch(`${API}/api/upload/chunk`, { method: "POST", body: fd }); };

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EXPORT — tries GPU backend, falls back to WASM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const checkBackendAlive = async () => {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
};

/* Backend GPU export — streams progress via polling */
const backendExport = async (proj, settings, onProgress, signal) => {
  const uploadedClips = proj.clips.filter(c => c.uploadStatus === "done");
  if (!uploadedClips.length) throw new Error("No server-uploaded clips. Use WASM mode.");
  const dim = proj.dimension;
  const fmt = dim.label === "Custom" ? `${proj.customW || 1920}:${proj.customH || 1080}` : dim.label;
  const body = {
    clip_ids: uploadedClips.map(c => c.id),
    in_points: Object.fromEntries(uploadedClips.map(c => [c.id, c.inPoint || 0])),
    out_points: Object.fromEntries(uploadedClips.map(c => [c.id, c.outPoint || c.duration])),
    format: fmt, fps: settings.fps || 30,
    crf: { high: 18, medium: 23, low: 28 }[settings.quality] || 23,
    max_duration: settings.maxDuration || 0, use_hwaccel: true,
  };
  onProgress(5, "Queuing server export…");
  const r = await fetch(`${API}/api/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Server ${r.status}`);
  const { job_id, encoder } = await r.json();
  onProgress(8, `Encoding with ${encoder}…`);

  while (true) {
    if (signal?.aborted) throw new Error("Cancelled");
    await new Promise(r => setTimeout(r, 800));
    const d = await fetch(`${API}/api/export/${job_id}`).then(r => r.json());
    onProgress(d.progress || 0, `${d.status}  ·  ${encoder}`);
    if (d.status === "done") return { url: `${API}/api/export/${job_id}/download`, isRemote: true };
    if (d.status === "error") throw new Error(d.error || "Export failed");
  }
};

/* WASM local export (CPU) */
const wasmExport = async (proj, settings, onProgress, signal) => {
  const dimW = proj.dimension.label === "Custom" ? proj.customW || 1920 : proj.dimension.w;
  const dimH = proj.dimension.label === "Custom" ? proj.customH || 1080 : proj.dimension.h;
  const crf = { high: "18", medium: "23", low: "28" }[settings.quality || "high"];
  onProgress(2, "Loading FFmpeg.wasm…"); await loadFF();
  if (signal?.aborted) throw new Error("Cancelled");
  const ordered = [...proj.clips].sort((a, b) => a.startTime - b.startTime);
  const segs = [];
  for (let i = 0; i < ordered.length; i++) {
    if (signal?.aborted) throw new Error("Cancelled");
    const c = ordered[i]; if (!c.file && !c.objectUrl) continue;
    onProgress(5 + Math.round((i / ordered.length) * 58), `Encoding ${i + 1}/${ordered.length}…`);
    const inN = `in_${i}.mp4`, outN = `seg_${i}.mp4`;
    const src = c.file || (await fetch(c.objectUrl).then(r => r.blob()));
    ff.FS("writeFile", inN, await fetchFile(src));
    const vf = `scale=${dimW}:${dimH}:force_original_aspect_ratio=increase,crop=${dimW}:${dimH},fps=${settings.fps || 30}`;
    await ff.run("-ss", String(c.inPoint || 0), "-t", String(clipDur(c)), "-i", inN, "-vf", vf, "-c:v", "libx264", "-crf", crf, "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", "-ac", "2", outN);
    ff.FS("unlink", inN); segs.push(outN);
  }
  if (!segs.length) throw new Error("No clips to export");
  onProgress(66, "Merging…");
  const fin = "output." + (settings.format || "mp4");
  if (segs.length === 1) { const d = ff.FS("readFile", segs[0]); ff.FS("writeFile", fin, d); }
  else { ff.FS("writeFile", "list.txt", segs.map(s => `file '${s}'`).join("\n")); await ff.run("-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", fin); ff.FS("unlink", "list.txt"); }
  segs.forEach(s => { try { ff.FS("unlink", s); } catch { } });
  onProgress(90, "Finalising…");
  const raw = ff.FS("readFile", fin);
  const mime = (settings.format === "webm") ? "video/webm" : (settings.format === "mov") ? "video/quicktime" : "video/mp4";
  const blob = new Blob([raw.buffer], { type: mime });
  try { ff.FS("unlink", fin); } catch { }
  onProgress(100, "Done");
  return { url: URL.createObjectURL(blob), isRemote: false };
};

/* Save blob/url to user-chosen file location */
const saveToFile = async (urlOrRes, filename) => {
  if (FSA_OK && window.showSaveFilePicker) {
    try {
      const ext = filename.split(".").pop() || "mp4";
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "Video", accept: { "video/mp4": [".mp4"], "video/quicktime": [".mov"], "video/webm": [".webm"] } }],
      });
      const writable = await handle.createWritable();
      const res = await fetch(urlOrRes);
      await res.body.pipeTo(writable);
      return handle.name;
    } catch (e) { if (e.name === "AbortError") return null; throw e; }
  }
  // Fallback: browser download link
  const a = document.createElement("a"); a.href = urlOrRes; a.download = filename; a.click();
  return filename;
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PROJECT FACTORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const mkTrack = (type, label) => ({ id: uid(), type, label, muted: false, locked: false, volume: 1 });

const mkProject = (name = "Untitled") => ({
  id: uid(), name,
  tracks: [
    mkTrack("video", "V1"), mkTrack("video", "V2"),
    mkTrack("audio", "A1"), mkTrack("audio", "A2"),
  ],
  clips: [], audioClips: [],
  selectedId: null, selectedAudioId: null,
  currentTime: 0, zoom: 80, isPlaying: false,
  dimension: DIMS[0], customW: 1920, customH: 1080,
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WAVEFORM CANVAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function WaveCanvas({ data, width, height = 38, color = "rgba(190,170,255,0.85)" }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current; if (!c || !data?.length) return;
    c.width = width; c.height = height;
    const ctx = c.getContext("2d"); ctx.clearRect(0, 0, width, height);
    const bw = width / data.length;
    data.forEach((v, i) => { const bh = Math.max(2, v * height * 0.88); ctx.fillStyle = color; ctx.fillRect(i * bw, (height - bh) / 2, Math.max(bw - 0.5, 1), bh); });
  }, [data, width, height, color]);
  return <canvas ref={ref} style={{ display: "block" }} />;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TRIM HANDLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function TrimHandle({ side, onTrim }) {
  const down = e => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX;
    const mv = ev => onTrim(ev.clientX - sx, false);
    const up = ev => { onTrim(ev.clientX - sx, true); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  };
  return <div className={`trim-handle trim-handle--${side}`} onMouseDown={down} />;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   VIDEO CLIP  (magnetic snap + track-drag)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function VideoClip({ clip, pps, isActive, tool, snapTimes, onSelect, onDrag, onTrimL, onTrimR, onCtxMenu, onCut }) {
  const [cutBlade, setCutBlade] = useState(null);
  const [dragging, setDragging] = useState(false);
  const w = Math.max(6, clipDur(clip) * pps);
  const thumbs = clip.frames || [];
  const count = Math.max(1, Math.floor(w / 80));
  const startR = clip.duration > 0 ? (clip.inPoint || 0) / clip.duration : 0;
  const endR = clip.duration > 0 ? (clip.outPoint || clip.duration) / clip.duration : 1;

  /* 16px magnetic threshold — feels sticky when near a snap point */
  const getMagnet = rawPx => {
    let bestPx = rawPx, bestLabel = null, snapped = false, bestDist = 16;
    for (const t of snapTimes) {
      const clipRel = t - clip.startTime;
      if (clipRel < 0 || clipRel > clipDur(clip)) continue;
      const sx = (clipRel / clipDur(clip)) * w;
      const dist = Math.abs(rawPx - sx);
      if (dist < bestDist) { bestDist = dist; bestPx = sx; bestLabel = fmtSecs(t); snapped = true; }
    }
    return { x: clamp(bestPx, 0, w), snapped, label: bestLabel, time: (clamp(bestPx, 0, w) / w) * clipDur(clip) };
  };

  const onCutMove = e => {
    if (tool !== "cut") return;
    const rect = e.currentTarget.getBoundingClientRect();
    setCutBlade(getMagnet(clamp(e.clientX - rect.left, 0, w)));
  };

  const startDrag = e => {
    if (tool !== "select") return;
    e.preventDefault(); e.stopPropagation(); onSelect();
    const sx = e.clientX, sy = e.clientY, orig = clip.startTime;
    let moved = false;
    /* snap during drag — clips lock to other clip edges and playhead */
    const getSnappedSt = dx => {
      let st = clamp(orig + dx / pps, 0, Infinity);
      const thresh = 16 / pps;
      for (const t of snapTimes) { if (Math.abs(st - t) < thresh) { st = t; break; } }
      return st;
    };
    const mv = ev => { if (Math.abs(ev.clientX - sx) > 3 || Math.abs(ev.clientY - sy) > 8) { moved = true; setDragging(true); } if (moved) onDrag(clip.id, getSnappedSt(ev.clientX - sx), ev.clientY, false); };
    const up = ev => { if (moved) onDrag(clip.id, getSnappedSt(ev.clientX - sx), ev.clientY, true); setDragging(false); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  };

  const handleClick = e => {
    if (tool !== "cut") return;
    const rect = e.currentTarget.getBoundingClientRect();
    onCut(clip.id, getMagnet(clamp(e.clientX - rect.left, 0, w)).time);
  };

  return (
    <div
      className={`vclip${isActive ? " vclip--active" : ""}${tool === "cut" ? " vclip--cut" : ""}${dragging ? " vclip--dragging" : ""}`}
      style={{ width: w, "--cc": clip.color }}
      onMouseDown={startDrag}
      onClick={handleClick}
      onContextMenu={e => { e.preventDefault(); onCtxMenu(e, clip.id); }}
      onMouseMove={onCutMove}
      onMouseLeave={() => setCutBlade(null)}
      title={`${clip.name} · ${fmtSecs(clipDur(clip))}`}
    >
      {thumbs.length > 0 ? (
        <div className="filmstrip">
          {Array.from({ length: count }, (_, i) => {
            const ratio = startR + (i / (count - 1 || 1)) * (endR - startR);
            const fi = Math.round(clamp(ratio, 0, 1) * (thumbs.length - 1));
            return <img key={i} src={thumbs[fi]} className="filmstrip__img" style={{ width: w / count }} draggable={false} alt="" />;
          })}
        </div>
      ) : (
        <div className="vclip__loading"><span className="vclip__spinner" />loading…</div>
      )}
      {w > 60 && <div className="vclip__label">{clip.name.replace(/\.[^.]+$/, "")}</div>}
      {clip.uploadStatus === "uploading" && <div className="vclip__prog" style={{ width: `${clip.uploadProgress}%` }} />}
      {clip.uploadStatus === "done" && <div className="vclip__tick">✓</div>}
      {isActive && tool === "select" && <><TrimHandle side="left" onTrim={(dx, c) => onTrimL(clip.id, dx / pps, c)} /><TrimHandle side="right" onTrim={(dx, c) => onTrimR(clip.id, dx / pps, c)} /></>}
      {tool === "cut" && cutBlade && (
        <div className={`cut-blade${cutBlade.snapped ? " cut-blade--snapped" : ""}`} style={{ left: cutBlade.x }}>
          <div className="cut-blade__line" />
          <span className="cut-blade__icon">✂</span>
          {cutBlade.snapped && <div className="cut-blade__label">{cutBlade.label}</div>}
        </div>
      )}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AUDIO STRIP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function AudioStrip({ ac, pps, isActive, linked, snapTimes, onSelect, onDrag, onCtxMenu }) {
  const [dragging, setDragging] = useState(false);
  const w = Math.max(4, clipDur(ac) * pps);
  const snapX = px => { for (const t of snapTimes) { if (Math.abs(t * pps - px) < SNAP_PX) return t * pps; } return px; };

  const startDrag = e => {
    if (linked) return;
    e.preventDefault(); e.stopPropagation(); onSelect();
    const sx = e.clientX, sy = e.clientY, orig = ac.startTime;
    let moved = false;
    const mv = ev => {
      if (Math.abs(ev.clientX - sx) > 3) { moved = true; setDragging(true); }
      if (moved) onDrag(ac.id, snapX(clamp(orig + (ev.clientX - sx) / pps, 0, Infinity) * pps) / pps, ev.clientY, false);
    };
    const up = ev => {
      if (moved) onDrag(ac.id, snapX(clamp(orig + (ev.clientX - sx) / pps, 0, Infinity) * pps) / pps, ev.clientY, true);
      setDragging(false);
      window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  };

  return (
    <div
      className={`audio-strip${isActive ? " audio-strip--active" : ""}${linked ? " audio-strip--linked" : ""}${dragging ? " audio-strip--dragging" : ""}`}
      style={{ width: w, "--ac": ac.color }}
      onMouseDown={startDrag}
      onClick={onSelect}
      onContextMenu={e => { e.preventDefault(); onCtxMenu(e, ac.id); }}
      title={`${ac.name} · ${fmtSecs(clipDur(ac))}${linked ? " (linked to video)" : ""}`}
    >
      <div className="audio-strip__header">
        <span className="audio-strip__icon">{linked ? "🔗" : "♪"}</span>
        {w > 90 && <span className="audio-strip__name">{ac.name.replace(/\.[^.]+$/, "")}</span>}
        {ac.muted && <span className="audio-strip__muted">M</span>}
      </div>
      <WaveCanvas data={ac.waveform} width={w} height={28} color={linked ? "rgba(160,140,255,0.75)" : "rgba(251,191,36,0.9)"} />
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TRANSFORM OVERLAY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function TransformOverlay({ clip, dimW, dimH, onChange }) {
  const tx = clip.transform || { x: 0, y: 0, scale: 1 };
  const startDrag = e => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = tx.x, oy = tx.y;
    const mv = ev => onChange({ ...tx, x: ox + (ev.clientX - sx) / dimW, y: oy + (ev.clientY - sy) / dimH });
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  };
  const onWheel = e => { e.preventDefault(); onChange({ ...tx, scale: clamp(tx.scale + (e.deltaY > 0 ? -0.05 : 0.05), 0.1, 5) }); };
  return (
    <div className="transform-overlay" onMouseDown={startDrag} onWheel={onWheel} title="Drag=move  Scroll=scale">
      <div className="transform-crosshair" />
      <div className="transform-info">{Math.round((tx.scale || 1) * 100)}%</div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PROJECT FOLDER PANEL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function FolderPanel({ dirHandle, onPick, onSave, onLoad, saving }) {
  return (
    <div className="folder-panel">
      <div className="folder-panel__title">Project folder</div>
      {dirHandle ? (
        <div className="folder-info">
          <span className="folder-icon">📁</span>
          <span className="folder-name">{dirHandle.name}</span>
          <span className="folder-status">{saving ? "saving…" : "saved"}</span>
        </div>
      ) : (
        <div className="folder-none">{FSA_OK ? "No folder chosen" : "Use Chrome/Edge for folder support"}</div>
      )}
      <div className="folder-btns">
        {FSA_OK && <button className="folder-btn" onClick={onPick}>{dirHandle ? "Change folder" : "Choose folder"}</button>}
        {dirHandle && <button className="folder-btn folder-btn--save" onClick={onSave}>💾 Save project</button>}
        {dirHandle && <button className="folder-btn" onClick={onLoad}>📂 Load project</button>}
        <button className="folder-btn" onClick={onSave}>⬇ Export JSON</button>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INFO TAB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function InfoTab({ clip }) {
  if (!clip) return (<div className="tab-empty"><div className="tab-empty__icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.259a1 1 0 01-1.447.894L15 14" /><rect x="3" y="6" width="12" height="12" rx="2" /></svg></div>Select a clip</div>);
  const rows = [["filename", clip.name], ["size", fmtBytes(clip.size)], ["duration", clip.duration ? fmtSecs(clip.duration) : "—"], ["in/out", `${fmtSecs(clip.inPoint || 0)} → ${fmtSecs(clip.outPoint || clip.duration)}`], ["session_id", clip.sessionId || "—"], ["status", clip.uploadStatus || "local"]];
  return (
    <div className="info-tab">
      {rows.map(([k, v]) => (<div className="info-row" key={k}><span className="info-key">{k}</span><span className={`info-val${k === "status" ? ` status--${clip.uploadStatus}` : ""}`}>{String(v)}</span></div>))}
      {clip.uploadStatus === "uploading" && (<div className="info-prog"><div className="info-prog__bar"><div className="info-prog__fill" style={{ width: `${clip.uploadProgress}%` }} /></div><span className="info-prog__label">{clip.uploadChunk}/{clip.uploadExpectedChunks} — {clip.uploadProgress}%</span></div>)}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DIMENSIONS TAB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function DimensionsTab({ project, onChange }) {
  const dim = project.dimension;
  const [cw, setCw] = useState(project.customW || 1920);
  const [ch, setCh] = useState(project.customH || 1080);
  const apply = d => { if (d.label === "Custom") onChange({ dimension: d, customW: cw, customH: ch }); else onChange({ dimension: d }); };
  return (
    <div className="dim-tab">
      <div className="dim-grid">
        {DIMS.map(d => (<button key={d.label} className={`dim-card${dim.label === d.label ? " dim-card--on" : ""}`} onClick={() => apply(d)}>
          <div className="dim-card__ratio" style={{ aspectRatio: `${d.w}/${d.h}` }}><div className="dim-card__inner" /></div>
          <div className="dim-card__label">{d.label}</div><div className="dim-card__desc">{d.desc}</div>
        </button>))}
      </div>
      {dim.label === "Custom" && (<div className="dim-custom">
        <div className="dim-custom__row"><label>W</label><input type="number" value={cw} min={100} max={7680} onChange={e => setCw(parseInt(e.target.value) || 1920)} onBlur={() => onChange({ dimension: dim, customW: cw, customH: ch })} /><span>px</span></div>
        <div className="dim-sep">×</div>
        <div className="dim-custom__row"><label>H</label><input type="number" value={ch} min={100} max={4320} onChange={e => setCh(parseInt(e.target.value) || 1080)} onBlur={() => onChange({ dimension: dim, customW: cw, customH: ch })} /><span>px</span></div>
        <button className="dim-apply" onClick={() => onChange({ dimension: dim, customW: cw, customH: ch })}>Apply</button>
      </div>)}
      <div className="dim-current">Current: <strong>{dim.label === "Custom" ? `${project.customW || 1920}×${project.customH || 1080}` : dim.desc}</strong> <span className="dim-px">{dim.label === "Custom" ? `${project.customW || 1920}×${project.customH || 1080} px` : `${dim.w}×${dim.h} px`}</span></div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EXPORT MODAL  (GPU backend or WASM, save to chosen folder)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function ExportModal({ project, onClose }) {
  const [format, setFormat] = useState("mp4");
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState("high");
  const [mode, setMode] = useState("auto"); // auto|backend|wasm
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [msg, setMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [encoder, setEncoder] = useState("");
  const [saved, setSaved] = useState("");
  const abortRef = useRef(null);
  const dim = project.dimension;
  const dimStr = dim.label === "Custom" ? `${project.customW || 1920}×${project.customH || 1080}` : `${dim.w}×${dim.h}`;
  const uploadedCount = project.clips.filter(c => c.uploadStatus === "done").length;

  const start = async () => {
    setStatus("exporting"); setProgress(0); setErrMsg(""); setSaved("");
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const settings = { format, fps, quality };
    try {
      let result;
      const useBackend = (mode === "auto" || mode === "backend") && await checkBackendAlive();
      if (useBackend) {
        setMsg("Connecting to server GPU…");
        try {
          result = await backendExport(project, settings, p => { setProgress(p); }, ctrl.signal);
          setEncoder("Server GPU");
        } catch (e) {
          if (mode === "backend") throw e;
          // auto-fallback to WASM
          setMsg("Server unavailable — using browser WASM…");
          result = await wasmExport(project, settings, (p, m) => { setProgress(p); setMsg(m); }, ctrl.signal);
          setEncoder("Browser WASM (CPU)");
        }
      } else {
        result = await wasmExport(project, settings, (p, m) => { setProgress(p); setMsg(m); }, ctrl.signal);
        setEncoder("Browser WASM (CPU)");
      }

      if (ctrl.signal.aborted) return;
      setProgress(99); setMsg("Saving file…");
      const filename = `clipmind_export_${Date.now()}.${format}`;
      const saved = await saveToFile(result.url, filename);
      setSaved(saved || filename);
      setStatus("done"); setProgress(100);
    } catch (e) {
      if (!ctrl.signal.aborted) { setStatus("error"); setErrMsg(e.message); }
    }
  };

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal__head"><span className="modal__title">Export</span><button className="modal__close" onClick={onClose}>✕</button></div>
        <div className="modal__body">
          <div className="export-info-row"><span className="export-info__label">Dimension</span><span className="export-info__val">{dimStr}</span></div>
          <div className="export-info-row"><span className="export-info__label">Clips</span><span className="export-info__val">{project.clips.length} total · {uploadedCount} on server</span></div>

          <div className="export-field">
            <div className="export-field__label">Engine</div>
            <div className="export-pills">
              <button className={`export-pill${mode === "auto" ? " export-pill--on" : ""}`} onClick={() => setMode("auto")}>Auto (GPU first)</button>
              <button className={`export-pill${mode === "backend" ? " export-pill--on" : ""}`} onClick={() => setMode("backend")}>Server GPU</button>
              <button className={`export-pill${mode === "wasm" ? " export-pill--on" : ""}`} onClick={() => setMode("wasm")}>Browser WASM</button>
            </div>
          </div>
          <div className="export-field"><div className="export-field__label">Format</div><div className="export-pills">{FORMATS.map(f => <button key={f} className={`export-pill${format === f ? " export-pill--on" : ""}`} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>)}</div></div>
          <div className="export-field"><div className="export-field__label">Frame rate</div><div className="export-pills">{FPS_OPTIONS.map(r => <button key={r} className={`export-pill${fps === r ? " export-pill--on" : ""}`} onClick={() => setFps(r)}>{r} fps</button>)}</div></div>
          <div className="export-field"><div className="export-field__label">Quality</div><div className="export-pills">{["high", "medium", "low"].map(q => <button key={q} className={`export-pill${quality === q ? " export-pill--on" : ""}`} onClick={() => setQuality(q)}>{q}</button>)}</div></div>

          {status === "exporting" && (
            <div className="export-prog">
              <div className="export-prog__bar"><div className="export-prog__fill" style={{ width: `${progress}%` }} /></div>
              <span className="export-prog__label">{msg || `${progress}%`}{encoder && ` · ${encoder}`}</span>
            </div>
          )}
          {status === "error" && <div className="export-err">{errMsg}</div>}
          {status === "done" && <div className="export-done"><span>✓ Saved: {saved}</span></div>}
          <div className="export-note">
            <strong>Auto:</strong> tries server GPU (VideoToolbox/NVENC) → falls back to browser WASM.
            Server mode requires clips uploaded via API. Browser mode works with any local clips.
          </div>
        </div>
        <div className="modal__foot">
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn-export-go" onClick={start} disabled={status === "exporting" || status === "done"}>{status === "exporting" ? "Exporting…" : "Export"}</button>
        </div>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CONTEXT MENU
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function CtxMenu({ x, y, clipId, audioId, onDelete, onSplit, onDetach, onClose }) {
  useEffect(() => { const h = () => onClose(); window.addEventListener("click", h, { once: true }); return () => window.removeEventListener("click", h); }, [onClose]);
  return (
    <div className="ctxmenu" style={{ left: x, top: y }}>
      {clipId && <>
        <button className="ctxmenu__item" onClick={() => { onSplit(clipId); onClose(); }}>✂ Split at playhead</button>
        <button className="ctxmenu__item" onClick={() => { onDetach(clipId, null); onClose(); }}>🔊 Detach audio</button>
        <div className="ctxmenu__sep" />
        <button className="ctxmenu__item ctxmenu__item--danger" onClick={() => { onDelete("clip", clipId); onClose(); }}>🗑 Delete clip</button>
      </>}
      {audioId && <>
        <button className="ctxmenu__item" onClick={() => { onDetach(null, audioId); onClose(); }}>🔗 Toggle link to video</button>
        <div className="ctxmenu__sep" />
        <button className="ctxmenu__item ctxmenu__item--danger" onClick={() => { onDelete("audio", audioId); onClose(); }}>🗑 Delete audio</button>
      </>}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TOAST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function Toast({ toast, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 6000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className={`toast toast--${toast.type}`}>
      <div className="toast__head"><span className="toast__icon">{toast.type === "ok" ? "↑" : "!"}</span><span className="toast__title">{toast.message || toast.filename}</span><button className="toast__close" onClick={onClose}>✕</button></div>
      {toast.payload && <pre className="toast__code">{JSON.stringify(toast.payload, null, 2)}</pre>}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ROOT APP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export default function App() {
  const [projects, setProjects] = useState([mkProject("Project 1")]);
  const [activePId, setActivePId] = useState(null);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [tool, setTool] = useState("select");
  const [showExport, setShowExport] = useState(false);
  const [showTransform, setShowTransform] = useState(false);
  const [toast, setToast] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [dropZone, setDropZone] = useState(false);
  const [rpTab, setRpTab] = useState("info");
  const [loaded, setLoaded] = useState(false);
  const [dirHandle, setDirHandle] = useState(null);
  const [saving, setSaving] = useState(false);

  const fileRef = useRef(), videoRef = useRef(), tlRef = useRef();
  const pid = activePId || projects[0]?.id;
  const proj = useMemo(() => projects.find(p => p.id === pid) || projects[0], [projects, pid]);

  /* ── undo / redo ── */
  const snap = useCallback(() => { setPast(p => [...p.slice(-(MAX_HIST - 1)), projects]); setFuture([]); }, [projects]);
  const undo = useCallback(() => { if (!past.length) return; setFuture(f => [projects, ...f.slice(0, MAX_HIST - 1)]); setProjects(past[past.length - 1]); setPast(p => p.slice(0, -1)); }, [past, projects]);
  const redo = useCallback(() => { if (!future.length) return; setPast(p => [...p, projects]); setProjects(future[0]); setFuture(f => f.slice(1)); }, [future, projects]);

  /* ── updaters ── */
  const updProj = useCallback(patch => setProjects(prev => prev.map(p => p.id === pid ? { ...p, ...(typeof patch === "function" ? patch(p) : patch) } : p)), [pid]);
  const updClip = (id, patch) => setProjects(prev => prev.map(p => p.id !== pid ? p : { ...p, clips: p.clips.map(c => c.id === id ? { ...c, ...patch } : c) }));
  const updAudio = (id, patch) => setProjects(prev => prev.map(p => p.id !== pid ? p : { ...p, audioClips: p.audioClips.map(a => a.id === id ? { ...a, ...patch } : a) }));

  const clips = proj?.clips || [], audioClips = proj?.audioClips || [], tracks = proj?.tracks || [];
  const selClip = clips.find(c => c.id === proj?.selectedId) || null;
  const totalDur = Math.max(60, clips.reduce((m, c) => Math.max(m, c.startTime + clipDur(c)), 0) + 4);
  const dim = proj?.dimension || DIMS[0];
  const dimW = dim.label === "Custom" ? proj?.customW || 1920 : dim.w;
  const dimH = dim.label === "Custom" ? proj?.customH || 1080 : dim.h;
  const zoom = proj?.zoom || 80;

  const videoTracks = tracks.filter(t => t.type === "video");
  const audioTracks = tracks.filter(t => t.type === "audio");

  /* snap points: playhead + all clip edges */
  const snapTimes = useMemo(() => {
    const s = new Set([proj?.currentTime || 0]);
    clips.forEach(c => { s.add(c.startTime); s.add(c.startTime + clipDur(c)); });
    return [...s];
  }, [clips, proj?.currentTime]);

  /* ── calculate track Y positions for drag-to-track ── */
  const trackYMap = useMemo(() => {
    const map = {};
    let y = RULER_H;
    videoTracks.forEach(t => { map[t.id] = { y, h: TRACK_H, type: "video" }; y += TRACK_H; });
    audioTracks.forEach(t => { map[t.id] = { y, h: AUDIO_H, type: "audio" }; y += AUDIO_H; });
    return map;
  }, [videoTracks, audioTracks]);

  const trackAtY = useCallback((clientY) => {
    if (!tlRef.current) return null;
    const rect = tlRef.current.getBoundingClientRect();
    const relY = clientY - rect.top + tlRef.current.scrollTop;
    for (const [id, info] of Object.entries(trackYMap)) {
      if (relY >= info.y && relY < info.y + info.h) return { id, type: info.type };
    }
    return null;
  }, [trackYMap]);

  /* ── load saved folder on mount + IDB resume ── */
  useEffect(() => {
    (async () => {
      // 1. Try saved folder first (fast native I/O)
      try {
        const h = await FS.getSavedFolder();
        if (h) {
          setDirHandle(h);
          const ps = await FS.loadProject(h);
          if (ps) { setProjects(ps); setActivePId(ps[0]?.id); setLoaded(true); return; }
        }
      } catch { }
      // 2. Fall back to IDB autosave (in-browser)
      try {
        const saved = await IDB.loadMeta("autosave");
        const ts = await IDB.loadMeta("autosave_ts");
        if (saved?.projects?.length && ts && Date.now() - ts < 7 * 24 * 3600 * 1000) {
          // Re-attach objectUrls from IDB blobs
          const restored = await Promise.all(saved.projects.map(async p => ({
            ...p,
            clips: await Promise.all((p.clips || []).map(async c => {
              try {
                const blob = await IDB.loadMeta(`blob_${c.id}`);
                if (blob) { return { ...c, objectUrl: URL.createObjectURL(blob) }; }
              } catch { }
              return c;
            })),
          })));
          setProjects(restored); setActivePId(restored[0]?.id); setLoaded(true);
          setToast({ type: "ok", message: `Resumed from ${new Date(ts).toLocaleString()}` });
          return;
        }
      } catch { }
      const init = mkProject("Project 1"); setProjects([init]); setActivePId(init.id); setLoaded(true);
    })();
  }, []);

  /* ── auto-save: folder (fast) + IDB (backup) — debounced 3s ── */
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      // save to folder
      if (dirHandle) { try { await FS.saveProject(dirHandle, projects); } catch { } }
      // save metadata to IDB (for resume without folder)
      try {
        await IDB.saveMeta("autosave", serializeProjects(projects));
        await IDB.saveMeta("autosave_ts", Date.now());
        // save blobs too so resume works
        for (const p of projects) {
          for (const c of p.clips) {
            if (c.file) await IDB.saveMeta(`blob_${c.id}`, c.file).catch(() => { });
          }
        }
      } catch { }
      setSaving(false);
    }, 3000);
  }, [projects, loaded, dirHandle]);

  /* ── folder actions ── */
  const pickFolder = async () => {
    if (!FSA_OK) return;
    try {
      const h = await FS.pickFolder();
      setDirHandle(h);
      setToast({ type: "ok", message: `Folder set: ${h.name}` });
    } catch { }
  };
  const saveProject = async () => {
    if (dirHandle) { setSaving(true); try { await FS.saveProject(dirHandle, projects); } catch { } setSaving(false); }
    else FS.downloadJSON(projects);
  };
  const loadProject = async () => {
    if (!dirHandle) return;
    try { const ps = await FS.loadProject(dirHandle); if (ps) { setProjects(ps); setActivePId(ps[0]?.id); } } catch (e) { setToast({ type: "error", message: e.message }); }
  };

  /* ── video sync ── */
  useEffect(() => { if (!videoRef.current || !selClip || !selClip.objectUrl) return; videoRef.current.src = selClip.objectUrl; videoRef.current.load(); }, [selClip?.id]); // eslint-disable-line

  useEffect(() => {
    const v = videoRef.current; if (!v || !selClip) return;
    const upd = () => updProj({ currentTime: selClip.startTime + v.currentTime });
    const end = () => updProj({ isPlaying: false });
    v.addEventListener("timeupdate", upd); v.addEventListener("ended", end);
    return () => { v.removeEventListener("timeupdate", upd); v.removeEventListener("ended", end); };
  }, [selClip?.id]); // eslint-disable-line

  const seek = useCallback(t => { const ct = clamp(t, 0, totalDur); updProj({ currentTime: ct }); if (videoRef.current && selClip) { const local = ct - selClip.startTime; if (local >= 0 && local <= selClip.duration) videoRef.current.currentTime = local; } }, [selClip, totalDur, updProj]);
  const togglePlay = useCallback(() => { const v = videoRef.current; if (!v || !selClip) return; if (proj.isPlaying) { v.pause(); updProj({ isPlaying: false }); } else { v.play().catch(() => { }); updProj({ isPlaying: true }); } }, [selClip, proj?.isPlaying, updProj]);

  /* ── DRAG (X = time, Y = track change) ── */
  const dragClip = useCallback((id, newSt, clientY, commit) => {
    if (commit) snap();
    const target = trackAtY(clientY);
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p;
      const clip = p.clips.find(c => c.id === id);
      const newTrackId = (target && target.type === "video") ? target.id : (clip?.trackId);
      const newClips = p.clips.map(c => c.id === id ? { ...c, startTime: newSt, trackId: newTrackId || c.trackId } : c);
      /* move linked audio too */
      const newAudio = p.audioClips.map(a => a.videoClipId === id && a.linked ? { ...a, startTime: newSt } : a);
      return { ...p, clips: newClips, audioClips: newAudio };
    }));
  }, [pid, snap, trackAtY]);

  const dragAudio = useCallback((id, newSt, clientY, commit) => {
    if (commit) snap();
    const target = trackAtY(clientY);
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p;
      const ac = p.audioClips.find(a => a.id === id);
      const newTrackId = (target && target.type === "audio") ? target.id : (ac?.trackId);
      return { ...p, audioClips: p.audioClips.map(a => a.id === id ? { ...a, startTime: newSt, trackId: newTrackId || a.trackId } : a) };
    }));
  }, [pid, snap, trackAtY]);

  /* ── TRIM ── */
  const trimLeft = useCallback((id, dt, commit) => { if (commit) snap(); setProjects(prev => prev.map(p => { if (p.id !== pid) return p; const c = p.clips.find(x => x.id === id); if (!c) return p; const newIn = clamp((c.inPoint || 0) + dt, 0, (c.outPoint || c.duration) - 0.2); const diff = newIn - (c.inPoint || 0); return { ...p, clips: p.clips.map(x => x.id === id ? { ...x, inPoint: newIn, startTime: x.startTime + diff } : x) }; })); }, [pid, snap]);
  const trimRight = useCallback((id, dt, commit) => { if (commit) snap(); setProjects(prev => prev.map(p => { if (p.id !== pid) return p; const c = p.clips.find(x => x.id === id); if (!c) return p; const newOut = clamp((c.outPoint || c.duration) + dt, (c.inPoint || 0) + 0.2, c.duration); return { ...p, clips: p.clips.map(x => x.id === id ? { ...x, outPoint: newOut } : x) }; })); }, [pid, snap]);

  /* ── DELETE ── */
  const deleteItem = useCallback((type, id) => {
    snap();
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p;
      if (type === "clip") { const filtered = p.clips.filter(c => c.id !== id); let t = 0; const packed = filtered.map(c => { const nc = { ...c, startTime: t }; t += clipDur(c); return nc; }); return { ...p, clips: packed, audioClips: p.audioClips.filter(a => a.videoClipId !== id), selectedId: null }; }
      return { ...p, audioClips: p.audioClips.filter(a => a.id !== id), selectedAudioId: null };
    }));
  }, [pid, snap]);

  /* ── CUT — both halves share parent frames (instant) ── */
  const cutClip = useCallback((clipId, relTime) => {
    snap();
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p;
      const clip = p.clips.find(c => c.id === clipId); if (!clip) return p;
      const offset = relTime != null ? relTime : (p.currentTime - clip.startTime);
      if (offset < 0.1 || offset > clipDur(clip) - 0.1) return p;
      /* INSTANT: share same frames array — thumbnails show correct portion via ratio */
      const A = { ...clip, id: uid(), outPoint: (clip.inPoint || 0) + offset };
      const B = { ...clip, id: uid(), startTime: clip.startTime + offset, inPoint: (clip.inPoint || 0) + offset };
      const sw = Math.floor((offset / clipDur(clip)) * (clip.waveform?.length || 0));
      A.waveform = clip.waveform?.slice(0, sw) || [];
      B.waveform = clip.waveform?.slice(sw) || [];
      const idx = p.clips.findIndex(c => c.id === clipId);
      const newClips = [...p.clips]; newClips.splice(idx, 1, A, B);
      const newAudio = p.audioClips.flatMap(a => {
        if (a.videoClipId !== clipId) return [a];
        const aW = Math.floor((offset / clipDur(a)) * (a.waveform?.length || 0));
        return [
          { ...a, id: uid(), videoClipId: A.id, outPoint: (a.inPoint || 0) + offset, waveform: a.waveform?.slice(0, aW) || [] },
          { ...a, id: uid(), videoClipId: B.id, startTime: a.startTime + offset, inPoint: (a.inPoint || 0) + offset, waveform: a.waveform?.slice(aW) || [] },
        ];
      });
      return { ...p, clips: newClips, audioClips: newAudio };
    }));
  }, [pid, snap]);

  /* ── DETACH AUDIO ── */
  const detachAudio = useCallback((clipId, audioId) => {
    snap();
    if (audioId) {
      const ac = audioClips.find(a => a.id === audioId);
      if (ac) updAudio(audioId, { linked: !ac.linked });
      return;
    }
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p;
      return { ...p, audioClips: p.audioClips.map(a => a.videoClipId === clipId ? { ...a, linked: !a.linked } : a) };
    }));
  }, [pid, snap, audioClips, updAudio]);

  /* ── PROCESS FILE ── */
  const processFile = useCallback(async file => {

    if (!file.type.startsWith("video/")) return;

    const sessionId = uid();
    const objectUrl = URL.createObjectURL(file);
    const clipId = uid(); // generate BEFORE setProjects
    const audioId = uid();

    const duration = await new Promise(res => {
      const v = document.createElement("video");
      v.preload = "metadata";

      v.onloadedmetadata = () => res(v.duration); v.onerror = () => res(0); v.src = objectUrl;
    });

    const vTrackId = videoTracks[0]?.id || "";
    const aTrackId = audioTracks[0]?.id || "";

    setProjects(
      prev => prev.map(p => {

        if (p.id !== pid) return p;

        const startTime = p.clips.reduce((m, c) => Math.max(m, c.startTime + clipDur(c)), 0);
        const color = PALETTE[p.clips.length % PALETTE.length];

        console.log('we just added this');

        return {
          ...p,
          clips: [
            ...p.clips,
            {
              id: clipId,
              file,
              name: file.name,
              size: file.size,
              duration,
              objectUrl,
              frames: [],
              waveform: [],
              color,
              startTime,
              inPoint: 0,
              outPoint: duration,
              trackId: vTrackId,
              audioClipId: audioId,
              transform: {
                x: 0,
                y: 0,
                scale: 1
              },
              sessionId,
              uploadStatus: "uploading",
              uploadProgress: 0,
              uploadChunk: 0,
              uploadExpectedChunks: Math.ceil(file.size / CHUNK_SIZE), uploadError: null,
            }
          ],
          /* create audio strip immediately, waveform added later */
          audioClips: [
            ...p.audioClips,
            {
              id: audioId, videoClipId: clipId, name: file.name,
              startTime: p.clips.reduce((m, c) => Math.max(m, c.startTime + clipDur(c)), 0),
              inPoint: 0, outPoint: duration,
              waveform: [], linked: true, muted: false, volume: 1,
              color: PALETTE[p.clips.length % PALETTE.length],
              trackId: aTrackId,
            }
          ],

          selectedId: clipId,
        };

      }

      ));

    /* save to project folder if set */
    if (dirHandle) {
      FS.saveProject(dirHandle, projects).catch(() => { });
    }

    /* server upload */
    try {
      const { payload, expectedChunks } = await apiInit(file, sessionId);
      setToast({ type: "ok", filename: file.name, payload });
      for (let i = 0; i < expectedChunks; i++) {
        const blob = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        try { await apiChunk(sessionId, i, blob); } catch { }
        updClip(clipId, { uploadChunk: i + 1, uploadProgress: Math.round(((i + 1) / expectedChunks) * 100) });
      }
      updClip(clipId, { uploadStatus: "done", uploadProgress: 100 });
    } catch (e) {
      updClip(clipId, { uploadStatus: "local", uploadProgress: 0, uploadError: e.message });
    }

    /* extract frames + real waveform */
    const [frames, waveform] = await Promise.all([extractFrames(objectUrl, 22), extractWaveform(file, 160)]);
    updClip(clipId, { frames, waveform });
    updAudio(audioId, { waveform }); // update audio strip with real waveform
  }, [pid, projects, videoTracks, audioTracks, dirHandle, updClip, updAudio]); // eslint-disable-line

  /* ── KEYBOARD ── */
  useEffect(() => {
    const onKey = e => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      if (e.key === "v" || e.key === "V") setTool("select");
      if (e.key === "c" || e.key === "C") setTool("cut");
      if (e.key === "t" || e.key === "T") setShowTransform(x => !x);
      if ((e.key === "Delete" || e.key === "Backspace") && proj?.selectedId) deleteItem("clip", proj.selectedId);
      if ((e.key === "s" || e.key === "S") && proj?.selectedId) { const c = proj.clips.find(x => x.id === proj.selectedId); if (c) cutClip(c.id, proj.currentTime - c.startTime); }
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      if (e.key === "+" || e.key === "=") updProj({ zoom: Math.min(400, zoom + 20) });
      if (e.key === "-") updProj({ zoom: Math.max(20, zoom - 20) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [proj, togglePlay, deleteItem, cutClip, undo, redo, updProj, zoom]);

  const onTlWheel = useCallback(e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); updProj({ zoom: Math.max(20, Math.min(400, zoom + (e.deltaY > 0 ? -15 : 15))) }); } }, [zoom, updProj]);

  const onRulerDown = e => {
    if (e.target.closest(".ruler-mark")) return;
    const tl = tlRef.current;
    const hit = ev => { const x = ev.clientX - tl.getBoundingClientRect().left + tl.scrollLeft; seek(x / zoom); };
    hit(e); const mv = ev => hit(ev); const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
  };

  /* ── TRACK MANAGEMENT ── */
  const addTrack = type => { snap(); const label = type === "video" ? `V${videoTracks.length + 1}` : `A${audioTracks.length + 1}`; updProj({ tracks: [...tracks, mkTrack(type, label)] }); };
  const removeTrack = id => { snap(); updProj({ tracks: tracks.filter(t => t.id !== id) }); };

  /* ── PROJECT TABS ── */
  const newProject = () => {
    const p = mkProject(`Project ${projects.length + 1}`);

    setProjects(ps => [...ps, p]);

    setActivePId(p.id);

  };

  const closeProject = id => { if (projects.length === 1) return; const r = projects.filter(p => p.id !== id); setProjects(r); if (pid === id) setActivePId(r[r.length - 1].id); };
  const renameProject = (id, name) => setProjects(ps => ps.map(p => p.id === id ? { ...p, name } : p));

  const step = zoom >= 100 ? 5 : zoom >= 50 ? 10 : 30;
  const totalPx = Math.ceil(totalDur) * zoom + 300;
  const marks = Array.from({ length: Math.ceil(totalDur / step) + 1 }, (_, i) => i * step);

  if (!loaded) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#080808", color: "#555", fontFamily: "monospace" }}>Loading…</div>;

  return (
    <div className={`editor${dropZone ? " editor--drop" : ""}`}
      onDragOver={e => { e.preventDefault(); setDropZone(true); }}
      onDragLeave={() => setDropZone(false)}
      onDrop={
        e => {
          e.preventDefault();
          setDropZone(false);
          [...e.dataTransfer.files].forEach(
            processFile
          );
        }}>

      <input ref={fileRef} type="file" multiple accept="video/*" style={{ display: "none" }}
        onChange={e => { [...e.target.files].forEach(processFile); e.target.value = ""; }} />

      {/* HEADER */}
      <header className="header">
        <button className="btn-new" onClick={() => fileRef.current.click()}><span className="btn-new__plus">+</span> New upload</button>
        <div className="proj-tabs">
          {projects.map(p => (
            <div key={p.id} className={`proj-tab${p.id === pid ? " proj-tab--on" : ""}`} onClick={() => setActivePId(p.id)}>
              <span className="proj-tab__name" contentEditable suppressContentEditableWarning onBlur={e => renameProject(p.id, e.target.textContent.trim() || "Untitled")} onClick={e => e.stopPropagation()}>{p.name}</span>
              {projects.length > 1 && <button className="proj-tab__close" onClick={e => { e.stopPropagation(); closeProject(p.id); }}>×</button>}
            </div>
          ))}
          <button className="proj-tab-new" onClick={newProject}>+</button>
        </div>
        <div className="toolbar">
          <button className={`tool-btn${tool === "select" ? " tool-btn--on" : ""}`} onClick={() => setTool("select")} title="Select (V)"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M4 0l16 12-7 1-4 8z" /></svg></button>
          <button className={`tool-btn${tool === "cut" ? " tool-btn--on" : ""}`} onClick={() => setTool("cut")} title="Cut (C)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" /></svg></button>
          <button className={`tool-btn${showTransform ? " tool-btn--on" : ""}`} onClick={() => setShowTransform(x => !x)} title="Transform (T)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 3H3v2M21 3h-2v2M5 21H3v-2M21 21h-2v-2M12 8v8M8 12h8" /></svg></button>
          <div className="tool-sep" />
          <button className="tool-btn" onClick={() => { if (proj?.selectedId) deleteItem("clip", proj.selectedId); }} title="Delete"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg></button>
          <button className="tool-btn" onClick={() => { const c = selClip; if (c) cutClip(c.id, proj.currentTime - c.startTime); }} title="Split (S)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20" /></svg></button>
          <div className="tool-sep" />
          <button className="tool-btn" onClick={undo} title="Undo ⌘Z" disabled={!past.length}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 14L4 9l5-5M4 9h11a6 6 0 010 12h-1" /></svg></button>
          <button className="tool-btn" onClick={redo} title="Redo ⌘⇧Z" disabled={!future.length}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 14l5-5-5-5M19 9H8a6 6 0 000 12h1" /></svg></button>
        </div>
        <div style={{ flex: 1 }} />
        <div className="header-save-status">{dirHandle ? (saving ? "● saving…" : "● saved") : ""}</div>
        <button className="btn-export-hdr" onClick={() => setShowExport(true)}>↑ Export</button>
      </header>

      {/* MAIN */}
      <div className="main">
        <div className="preview">
          <div className="video-stage">
            <div className="dim-frame" style={{ aspectRatio: `${dimW}/${dimH}` }}>
              {selClip && selClip.objectUrl ? (
                <>
                  <video ref={videoRef} className="video-el" playsInline
                    style={{ objectFit: "cover", transform: selClip.transform ? `translate(${(selClip.transform.x || 0) * 100}%,${(selClip.transform.y || 0) * 100}%) scale(${selClip.transform.scale || 1})` : "none" }} />
                  {showTransform && <TransformOverlay clip={selClip} dimW={dimW} dimH={dimH} onChange={t => updClip(selClip.id, { transform: t })} />}
                </>
              ) : (
                <div className="video-empty" onClick={() => fileRef.current.click()}>
                  <div className="video-empty__circle"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.259a1 1 0 01-1.447.894L15 14" /><rect x="3" y="6" width="12" height="12" rx="2" /></svg></div>
                  <p>Drop video or click New upload</p>
                </div>
              )}
              <div className="dim-badge">{dim.label === "Custom" ? `${dimW}×${dimH}` : dim.label}</div>
            </div>
          </div>
          <div className="controls">
            <span className="timecode">{fmtSecs(proj?.currentTime || 0)}</span>
            <div className="ctrl-group">
              <button className="ctrl" onClick={() => seek((proj?.currentTime || 0) - 15)}>⟨15</button>
              <button className="ctrl" onClick={() => seek((proj?.currentTime || 0) - 1)}>‹</button>
              <button className="ctrl ctrl--play" onClick={togglePlay}>
                {proj?.isPlaying ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg> : <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>}
              </button>
              <button className="ctrl" onClick={() => seek((proj?.currentTime || 0) + 1)}>›</button>
              <button className="ctrl" onClick={() => seek((proj?.currentTime || 0) + 15)}>15⟩</button>
            </div>
            <div className="ctrl-right">
              <span className="timecode">{selClip ? fmtSecs(clipDur(selClip)) : "00:00"}</span>
              <div className="aspect-pill" onClick={() => setRpTab("dimensions")}>{dim.label} ▾</div>
            </div>
          </div>
        </div>

        <aside className="rp">
          <div className="rp__tabs">{["info", "dimensions", "folder", "export"].map(t => <button key={t} className={`rp__tab${rpTab === t ? " rp__tab--on" : ""}`} onClick={() => setRpTab(t)}>{t}</button>)}</div>
          <div className="rp__body">
            {rpTab === "info" && <InfoTab clip={selClip} />}
            {rpTab === "dimensions" && <DimensionsTab project={proj} onChange={updProj} />}
            {rpTab === "folder" && <FolderPanel dirHandle={dirHandle} onPick={pickFolder} onSave={saveProject} onLoad={loadProject} saving={saving} />}
            {rpTab === "export" && <div className="tab-empty"><button className="btn-export-go" style={{ marginTop: 0 }} onClick={() => setShowExport(true)}>↑ Open export</button></div>}
          </div>
        </aside>
      </div>

      {/* TIMELINE */}
      <div className="tl-shell">
        <div className="tl-bar">
          <span className="tl-bar__label">{clips.length} clips · {fmtSecs(proj?.currentTime || 0)}</span>
          <div className="tl-tools-hint">{tool === "cut" ? <span className="tool-hint tool-hint--cut">✂ Click clip to split · snaps to nearest marker</span> : <span className="tool-hint">V=select  C=cut  T=transform  S=split  Del  ⌘Z/⌘⇧Z  drag clips between tracks vertically</span>}</div>
          <div className="tl-track-add">
            <button className="add-track-btn" onClick={() => addTrack("video")}>+ Video track</button>
            <button className="add-track-btn" onClick={() => addTrack("audio")}>+ Audio track</button>
          </div>
          <div className="tl-zoom">
            <button className="zoom-btn" onClick={() => updProj({ zoom: Math.max(20, zoom - 20) })}>−</button>
            <input type="range" className="zoom-slider" min={20} max={300} value={zoom} onChange={e => updProj({ zoom: parseInt(e.target.value) })} />
            <button className="zoom-btn" onClick={() => updProj({ zoom: Math.min(300, zoom + 20) })}>+</button>
            <span className="zoom-val">{zoom}px/s</span>
          </div>
        </div>

        <div className="tl-scroll" ref={tlRef} onWheel={onTlWheel}>
          {/* Ruler */}
          <div className="ruler-row">
            <div className="tl-gutter tl-gutter--ruler" />
            <div className="ruler" style={{ width: totalPx }} onMouseDown={onRulerDown}>
              {marks.map(t => <div key={t} className="ruler-mark" style={{ left: t * zoom }}><span className="ruler-mark__label">{fmtRuler(t)}</span></div>)}
              <div className="playhead" style={{ left: (proj?.currentTime || 0) * zoom }}>
                <div className="playhead__head" />
                <div className="playhead__line" style={{ height: (videoTracks.length * TRACK_H + audioTracks.length * AUDIO_H) + "px" }} />
              </div>
            </div>
          </div>

          {/* VIDEO TRACKS — each is its own independent row */}
          {videoTracks.map((track, ti) => (
            <div key={track.id} className="track-row">
              <div className="tl-gutter">
                <span className="track-label-text">{track.label}</span>
                <button className="track-action-btn" onClick={() => removeTrack(track.id)} title="Remove track">×</button>
              </div>
              <div className="track" style={{ width: totalPx }}>
                {clips.filter(c => (c.trackId || videoTracks[0]?.id) === track.id).map(c => (
                  <div key={c.id} className="track__slot" style={{ left: c.startTime * zoom }}>
                    <VideoClip clip={c} pps={zoom} isActive={c.id === proj?.selectedId} tool={tool}
                      snapTimes={snapTimes}
                      onSelect={() => updProj({ selectedId: c.id })}
                      onDrag={dragClip} onTrimL={trimLeft} onTrimR={trimRight}
                      onCtxMenu={(e, id) => setCtxMenu({ x: e.clientX, y: e.clientY, clipId: id })}
                      onCut={cutClip} />
                  </div>
                ))}
                {clips.filter(c => (c.trackId || videoTracks[0]?.id) === track.id).length === 0 && (
                  <div className="track__empty">Video layer {ti + 1} — drag clips here</div>
                )}
              </div>
            </div>
          ))}

          {/* SEPARATOR */}
          <div className="track-separator" />

          {/* AUDIO TRACKS — each is its own independent row */}
          {audioTracks.map((track, ti) => (
            <div key={track.id} className="track-row">
              <div className="tl-gutter tl-gutter--audio">
                <span className="track-label-text">{track.label}</span>
                <button className="track-action-btn" onClick={() => removeTrack(track.id)} title="Remove track">×</button>
              </div>
              <div className="track track--audio" style={{ width: totalPx }}>
                {audioClips.filter(a => (a.trackId || audioTracks[0]?.id) === track.id).map(ac => {
                  const linked = clips.find(c => c.id === ac.videoClipId);
                  const dispStart = ac.linked && linked ? linked.startTime : ac.startTime;
                  return (
                    <div key={ac.id} className="track__slot" style={{ left: dispStart * zoom }}>
                      <AudioStrip ac={{ ...ac, startTime: dispStart }} pps={zoom}
                        isActive={ac.id === proj?.selectedAudioId}
                        linked={ac.linked} snapTimes={snapTimes}
                        onSelect={() => updProj({ selectedAudioId: ac.id })}
                        onDrag={dragAudio}
                        onCtxMenu={(e, id) => setCtxMenu({ x: e.clientX, y: e.clientY, audioId: id })} />
                    </div>
                  );
                })}
                {audioClips.filter(a => (a.trackId || audioTracks[0]?.id) === track.id).length === 0 && (
                  <div className="track__empty track__empty--audio">Audio channel {ti + 1} — drag audio here or detach from video</div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="tl-statusbar">
          {proj?.selectedId ? <span>Selected · <kbd>S</kbd> split · <kbd>Del</kbd> delete · drag edges to trim · drag vertically to change layer</span> : <span><kbd>Space</kbd> play · <kbd>C</kbd> cut · <kbd>T</kbd> transform · right-click clips for options</span>}
        </div>
      </div>

      {ctxMenu && <CtxMenu x={ctxMenu.x} y={ctxMenu.y} clipId={ctxMenu.clipId} audioId={ctxMenu.audioId}
        onDelete={deleteItem} onSplit={id => cutClip(id, null)} onDetach={detachAudio} onClose={() => setCtxMenu(null)} />}
      {showExport && <ExportModal project={proj} onClose={() => setShowExport(false)} />}
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
      {dropZone && <div className="drop-overlay"><div className="drop-overlay__box"><div className="drop-overlay__icon">↑</div><div className="drop-overlay__text">Drop video to add to timeline</div></div></div>}
    </div>
  );
}