/* Image Compare — images are aligned and diffed locally with <canvas>. Nothing is uploaded. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$;
  const saved = S3.store("compare") || {};
  const st = {
    mode: ["slider", "side", "onion", "diff"].indexOf(saved.mode) >= 0 ? saved.mode : "slider",
    align: ["tl", "center", "stretch"].indexOf(saved.align) >= 0 ? saved.align : "tl",
    opacity: saved.opacity != null ? saved.opacity : 50, threshold: saved.threshold || 0,
    A: null, B: null, // {img, name, url}
    W: 0, H: 0, ca: null, cb: null, heat: null, res: null,
    zoom: 1, px: 0, py: 0, split: 0.5
  };
  function save() { S3.store("compare", { mode: st.mode, align: st.align, opacity: st.opacity, threshold: st.threshold }); }
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }

  // ---------- pure maths (UI + self-test) ----------
  // Place both images on one W×H grid. Areas only one image covers are transparent in the other, so they count as changed.
  function alignSize(aw, ah, bw, bh, mode) { return mode === "stretch" ? { W: aw, H: ah } : { W: Math.max(aw, bw), H: Math.max(ah, bh) }; }
  function placed(src, sw, sh, W, H, mode, isB) {
    const c = canvas(W, H), x = c.getContext("2d");
    if (mode === "stretch" && isB) { x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, W, H); }
    else if (mode === "center") x.drawImage(src, Math.floor((W - sw) / 2), Math.floor((H - sh) / 2));
    else x.drawImage(src, 0, 0);
    return c;
  }
  // a, b: RGBA arrays of the same size. A pixel counts as changed when any channel differs by more than `threshold`.
  // Returns counts and a heatmap: unchanged pixels are a faded grey copy of A, changed ones go yellow → red with the size of the change.
  function diff(a, b, W, H, threshold) {
    const heat = new Uint8ClampedArray(W * H * 4);
    let changed = 0, maxD = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
      if (d > maxD) maxD = d;
      if (d > threshold) {
        changed++;
        const t = Math.min(1, d / 160);
        heat[i] = 255; heat[i + 1] = Math.round(220 * (1 - t)); heat[i + 2] = Math.round(40 * (1 - t)); heat[i + 3] = 255;
      } else {
        const al = a[i + 3] / 255, l = (0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]) * al + 255 * (1 - al);
        const v = Math.round(200 + l * 0.2); heat[i] = heat[i + 1] = heat[i + 2] = v; heat[i + 3] = 255;
      }
    }
    return { changed, total: W * H, pct: W * H ? changed / (W * H) * 100 : 0, maxD, heat };
  }
  function fmtPct(p) { return p === 0 ? "0%" : p < 0.01 ? "<0.01%" : p < 10 ? p.toFixed(2) + "%" : p.toFixed(1) + "%"; }

  // ---------- loading ----------
  function loadImage(file) {
    const url = URL.createObjectURL(file), img = new Image();
    img.src = url;
    return img.decode().then(() => ({ img, url, name: file.name || "image", size: file.size })).catch(() => { URL.revokeObjectURL(url); throw new Error("Can't read " + (file.name || "this image")); });
  }
  async function setSlot(slot, file) {
    try {
      const r = await loadImage(file);
      if (st[slot]) URL.revokeObjectURL(st[slot].url);
      st[slot] = r; showSlot(slot); prepare(true);
    } catch (e) { S3.toast(e.message, "error"); }
  }
  function showSlot(slot) {
    const s = st[slot], t = $("#thumb" + slot);
    t.hidden = !s; if (s) t.src = s.url;
    $("#name" + slot).textContent = s ? s.name : "Drop image " + slot;
    $("#info" + slot).textContent = s ? s.img.naturalWidth + "×" + s.img.naturalHeight + (s.size ? " · " + S3.fmtBytes(s.size) : "") : slot === "A" ? "or click · paste fills the empty slot" : "or click · drop two files at once to fill both";
    $("#drop" + slot).classList.toggle("has-img", !!s);
  }
  function onFiles(slot) {
    return files => {
      if (files.length >= 2) { setSlot("A", files[0]).then(() => setSlot("B", files[1])); return; }
      setSlot(slot, files[0]);
    };
  }

  // ---------- prepare aligned canvases + diff ----------
  function prepare(refit) {
    const ready = st.A && st.B;
    $("#empty").hidden = !!ready; $("#swap").disabled = !(st.A || st.B);
    $("#export").disabled = !ready; $("#stats").hidden = !ready; $("#verdict").hidden = !ready;
    if (!ready) { st.ca = st.cb = st.heat = null; draw(); return; }
    const a = st.A.img, b = st.B.img, aw = a.naturalWidth, ah = a.naturalHeight, bw = b.naturalWidth, bh = b.naturalHeight;
    const s = alignSize(aw, ah, bw, bh, st.align);
    const sizeChanged = s.W !== st.W || s.H !== st.H;
    st.W = s.W; st.H = s.H;
    st.ca = placed(a, aw, ah, s.W, s.H, st.align, false);
    st.cb = placed(b, bw, bh, s.W, s.H, st.align, true);
    st.da = st.ca.getContext("2d").getImageData(0, 0, s.W, s.H).data;
    st.db = st.cb.getContext("2d").getImageData(0, 0, s.W, s.H).data;
    runDiff();
    if (refit || sizeChanged) fit();
    draw();
  }
  function runDiff() {
    if (!st.da) return;
    const r = diff(st.da, st.db, st.W, st.H, st.threshold);
    st.res = r;
    st.heat = canvas(st.W, st.H);
    st.heat.getContext("2d").putImageData(new ImageData(r.heat, st.W, st.H), 0, 0);
    const a = st.A.img, b = st.B.img, same = a.naturalWidth === b.naturalWidth && a.naturalHeight === b.naturalHeight;
    $("#stats").innerHTML = [
      [r.changed.toLocaleString(), "changed pixels"], [fmtPct(r.pct), "of the image"], [r.maxD, "largest difference (0–255)"],
      [st.W + "×" + st.H, same ? "compared" : "compared (sizes differ)"]
    ].map(v => '<div class="stat"><b>' + S3.esc(v[0]) + "</b><span>" + S3.esc(v[1]) + "</span></div>").join("");
    const vd = $("#verdict");
    if (!r.changed) { vd.className = "chip ok"; vd.textContent = st.threshold ? "No differences above the threshold" : "Identical pixels"; }
    else { vd.className = "chip warn"; vd.textContent = (same ? "" : "Sizes differ: " + a.naturalWidth + "×" + a.naturalHeight + " vs " + b.naturalWidth + "×" + b.naturalHeight + " · ") + r.changed.toLocaleString() + " pixels differ"; }
  }

  // ---------- view: one shared zoom/pan for every mode and both side-by-side panes ----------
  const view = $("#view"), c1 = $("#c1"), c2 = $("#c2");
  function paneSize() {
    const W = view.clientWidth, H = view.clientHeight;
    if (st.mode !== "side") return { w: W, h: H };
    return W >= 640 ? { w: Math.floor((W - 8) / 2), h: H } : { w: W, h: Math.floor((H - 8) / 2) };
  }
  function fit() {
    if (!st.W) return;
    const p = paneSize(), z = Math.min(p.w / st.W, p.h / st.H, 1) * 0.96 || 1;
    st.zoom = z; st.px = (p.w - st.W * z) / 2; st.py = (p.h - st.H * z) / 2;
    $("#zoomV").textContent = Math.round(z * 100) + "%";
  }
  function zoomAt(z, cx, cy) {
    z = Math.max(0.02, Math.min(32, z));
    st.px = cx - (cx - st.px) * z / st.zoom; st.py = cy - (cy - st.py) * z / st.zoom; st.zoom = z;
    $("#zoomV").textContent = Math.round(z * 100) + "%"; draw();
  }
  function sizeCanvas(c, w, h) {
    const dpr = window.devicePixelRatio || 1;
    c.style.width = w + "px"; c.style.height = h + "px";
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const x = c.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height);
    x.setTransform(dpr * st.zoom, 0, 0, dpr * st.zoom, dpr * st.px, dpr * st.py);
    x.imageSmoothingEnabled = st.zoom < 2;
    return x;
  }
  function draw() {
    const side = st.mode === "side", p = paneSize();
    view.classList.toggle("is-side", side); view.classList.toggle("is-stack", side && view.clientWidth < 640);
    c2.hidden = !side;
    $("#lblL").textContent = st.mode === "diff" ? "Difference" : st.mode === "onion" ? "A + B" : "A";
    $("#lblR").hidden = st.mode === "diff" || st.mode === "onion";
    if (!st.ca) { sizeCanvas(c1, p.w, p.h); c2.hidden = true; $("#lblL").hidden = $("#lblR").hidden = true; return; }
    $("#lblL").hidden = false;
    const x = sizeCanvas(c1, p.w, p.h);
    if (st.mode === "slider") {
      x.drawImage(st.cb, 0, 0);
      const sx = st.split * p.w; // split position in screen px
      x.save(); x.setTransform(1, 0, 0, 1, 0, 0);
      const dpr = c1.width / p.w;
      x.beginPath(); x.rect(0, 0, sx * dpr, c1.height); x.clip();
      x.setTransform(dpr * st.zoom, 0, 0, dpr * st.zoom, dpr * st.px, dpr * st.py);
      x.drawImage(st.ca, 0, 0); x.restore();
      x.save(); x.setTransform(1, 0, 0, 1, 0, 0);
      x.fillStyle = "#ffffff"; x.fillRect(sx * dpr - dpr, 0, 2 * dpr, c1.height);
      x.beginPath(); x.arc(sx * dpr, c1.height / 2, 14 * dpr, 0, Math.PI * 2); x.fill();
      x.fillStyle = "#14171b"; x.font = (12 * dpr) + "px Inter, system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText("⇆", sx * dpr, c1.height / 2 + dpr);
      x.restore();
    } else if (st.mode === "side") {
      x.drawImage(st.ca, 0, 0);
      sizeCanvas(c2, p.w, p.h).drawImage(st.cb, 0, 0);
    } else if (st.mode === "onion") {
      x.drawImage(st.ca, 0, 0); x.globalAlpha = st.opacity / 100; x.drawImage(st.cb, 0, 0); x.globalAlpha = 1;
    } else {
      x.drawImage(st.heat, 0, 0);
    }
    const lr = $("#lblR");
    if (st.mode === "side") { lr.style.left = view.clientWidth >= 640 ? (p.w + 18) + "px" : ""; lr.style.top = view.clientWidth >= 640 ? "" : (p.h + 18) + "px"; lr.classList.add("side"); }
    else { lr.style.left = lr.style.top = ""; lr.classList.remove("side"); }
  }

  // drag: pan (or move the slider when grabbing near the line); wheel / pinch: zoom
  const ptrs = new Map();
  let drag = null;
  function local(e) { const r = (e.target === c2 ? c2 : c1).getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  view.addEventListener("pointerdown", e => {
    if (!st.ca || e.button > 0) return;
    view.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = local(e), pw = paneSize().w;
    if (ptrs.size === 2) { const v = [...ptrs.values()]; drag = { kind: "pinch", d: Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y), z: st.zoom }; return; }
    if (st.mode === "slider" && Math.abs(p.x - st.split * pw) < 22) drag = { kind: "split" };
    else drag = { kind: "pan", x: e.clientX, y: e.clientY };
    if (drag.kind === "split") setSplit(p.x / pw);
  });
  view.addEventListener("pointermove", e => {
    if (!drag) {
      if (st.ca && st.mode === "slider" && e.target === c1) view.style.cursor = Math.abs(local(e).x - st.split * paneSize().w) < 22 ? "ew-resize" : "grab";
      return;
    }
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.kind === "pinch" && ptrs.size === 2) {
      const v = [...ptrs.values()], d = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y), r = c1.getBoundingClientRect();
      zoomAt(drag.z * d / drag.d, (v[0].x + v[1].x) / 2 - r.left, (v[0].y + v[1].y) / 2 - r.top);
    } else if (drag.kind === "split") setSplit(local(e).x / paneSize().w);
    else if (drag.kind === "pan") { st.px += e.clientX - drag.x; st.py += e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; draw(); }
  });
  function endPtr(e) { ptrs.delete(e.pointerId); if (!ptrs.size) drag = null; }
  view.addEventListener("pointerup", endPtr); view.addEventListener("pointercancel", endPtr);
  view.addEventListener("wheel", e => {
    if (!st.ca) return; e.preventDefault();
    const p = local(e); zoomAt(st.zoom * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  view.addEventListener("keydown", e => {
    if (!st.ca) return;
    const p = paneSize(), k = e.key;
    if (k === "+" || k === "=") zoomAt(st.zoom * 1.25, p.w / 2, p.h / 2);
    else if (k === "-" || k === "_") zoomAt(st.zoom / 1.25, p.w / 2, p.h / 2);
    else if (k === "0") { fit(); draw(); }
    else if (k === "1") zoomAt(1, p.w / 2, p.h / 2);
    else if (st.mode === "slider" && (k === "ArrowLeft" || k === "ArrowRight") && !e.shiftKey) setSplit(st.split + (k === "ArrowLeft" ? -0.02 : 0.02));
    else if (k.indexOf("Arrow") === 0) { const s = 40; if (k === "ArrowLeft") st.px += s; if (k === "ArrowRight") st.px -= s; if (k === "ArrowUp") st.py += s; if (k === "ArrowDown") st.py -= s; draw(); }
    else return;
    e.preventDefault();
  });
  function setSplit(v) { st.split = Math.max(0, Math.min(1, v)); draw(); }

  // ---------- controls ----------
  function pressSeg(el, v) { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x.dataset.v === v))); }
  function setMode(v) {
    const prevSide = st.mode === "side"; st.mode = v; pressSeg($("#mode"), v); save();
    $("#opWrap").hidden = v !== "onion"; $("#thWrap").hidden = v !== "diff";
    $("#hint").textContent = v === "slider" ? "Drag the line to compare · drag elsewhere to pan · scroll to zoom" : v === "side" ? "Both views zoom and pan together" : "Drag to pan · scroll to zoom";
    if (prevSide !== (v === "side")) fit();
    draw();
  }
  $$("#mode button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.v)));
  const op = $("#opacity"), th = $("#threshold");
  op.value = st.opacity; $("#opV").textContent = st.opacity + "%";
  op.addEventListener("input", () => { st.opacity = +op.value; $("#opV").textContent = op.value + "%"; save(); draw(); });
  th.value = st.threshold; $("#thV").textContent = st.threshold;
  const rediff = S3.debounce(() => { runDiff(); draw(); }, 60);
  th.addEventListener("input", () => { st.threshold = +th.value; $("#thV").textContent = th.value; save(); rediff(); });
  $("#align").value = st.align;
  $("#align").addEventListener("change", e => { st.align = e.target.value; save(); prepare(true); });
  $("#swap").addEventListener("click", () => { const t = st.A; st.A = st.B; st.B = t; showSlot("A"); showSlot("B"); prepare(false); });
  $("#zoomIn").addEventListener("click", () => { const p = paneSize(); zoomAt(st.zoom * 1.25, p.w / 2, p.h / 2); });
  $("#zoomOut").addEventListener("click", () => { const p = paneSize(); zoomAt(st.zoom / 1.25, p.w / 2, p.h / 2); });
  $("#fitBtn").addEventListener("click", () => { fit(); draw(); });
  $("#oneBtn").addEventListener("click", () => { const p = paneSize(); zoomAt(1, p.w / 2, p.h / 2); });
  $("#export").addEventListener("click", () => {
    if (!st.heat) return;
    st.heat.toBlob(b => { if (b) { S3.download(b, "diff-" + st.A.name.replace(/\.[^.]+$/, "") + "-vs-" + st.B.name.replace(/\.[^.]+$/, "") + ".png"); S3.done(); } }, "image/png");
  });
  S3.drop($("#dropA"), onFiles("A"), { accept: "image/*", multiple: true });
  S3.drop($("#dropB"), onFiles("B"), { accept: "image/*", multiple: true });
  document.addEventListener("paste", e => {
    const fs = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type));
    if (!fs.length) return;
    e.preventDefault();
    const name = (f, i) => f.name && f.name !== "image.png" ? f : new File([f], "pasted-" + (i + 1) + ".png", { type: f.type });
    if (fs.length >= 2) onFiles("A")(fs.map(name)); else setSlot(!st.A ? "A" : "B", name(fs[0], st.A ? 1 : 0));
  });
  if (window.ResizeObserver) new ResizeObserver(S3.debounce(() => { fit(); draw(); }, 60)).observe(view);
  setMode(st.mode);
  prepare(true);

  // ---------- demo: two drawn pictures with a few differences ----------
  function scene(v2) {
    const W = 900, H = 520, c = canvas(W, H), x = c.getContext("2d");
    const sky = x.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, "#1b2a5a"); sky.addColorStop(0.6, "#e0708b"); sky.addColorStop(1, "#ffc27a");
    x.fillStyle = sky; x.fillRect(0, 0, W, H);
    x.fillStyle = "#ffe7a8"; x.beginPath(); x.arc(v2 ? 640 : 600, v2 ? 205 : 220, 58, 0, Math.PI * 2); x.fill();
    if (v2) { x.fillStyle = "rgba(255,255,255,.85)"; [[210, 120, 46], [255, 108, 58], [300, 124, 40]].forEach(q => { x.beginPath(); x.arc(q[0], q[1], q[2], 0, Math.PI * 2); x.fill(); }); }
    [["#3b2c5e", 0.66, 5], ["#2a2049", 0.76, 8], ["#151231", 0.88, 12]].forEach((m, i) => {
      x.fillStyle = m[0]; x.beginPath(); x.moveTo(0, H);
      for (let k = 0; k <= 90; k++) { const px = W * k / 90; x.lineTo(px, H * m[1] - Math.abs(Math.sin(px / W * m[2] + i)) * H * (0.15 - i * 0.04)); }
      x.lineTo(W, H); x.fill();
    });
    x.fillStyle = "#fff"; x.font = "700 34px Inter, Arial, sans-serif"; x.fillText(v2 ? "Summer trip 2026" : "Summer trip 2025", 40, 64);
    x.fillStyle = "#ffd36b"; x.beginPath(); x.arc(v2 ? 790 : 120, 470, 10, 0, Math.PI * 2); x.fill();
    return c;
  }
  window.S3_DEMO = async function () {
    const blobs = await Promise.all([scene(false), scene(true)].map(c => new Promise(r => c.toBlob(r, "image/png"))));
    await setSlot("A", new File([blobs[0]], "poster-v1.png", { type: "image/png" }));
    await setSlot("B", new File([blobs[1]], "poster-v2.png", { type: "image/png" }));
    setMode("slider"); setSplit(0.56);
  };

  // Self-test run by scripts/smoke.py: diff counts on synthetic images with known changes.
  window.S3_SELFTEST = async function () {
    const W = 100, H = 80, a = new Uint8ClampedArray(W * H * 4);
    let s = 3;
    for (let i = 0; i < a.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = 40 + s % 100; a[i + 1] = 40 + (s >> 8) % 100; a[i + 2] = 40 + (s >> 16) % 100; a[i + 3] = 255; }
    const b = new Uint8ClampedArray(a);
    for (let y = 10; y < 20; y++) for (let x = 30; x < 40; x++) b[(y * W + x) * 4] += 100;     // 100 px block, Δ=100
    [[1, 1], [50, 50], [99, 79], [0, 79], [70, 5]].forEach(p => { b[(p[1] * W + p[0]) * 4 + 2] += 20; }); // 5 px, Δ=20
    const r0 = diff(a, b, W, H, 0), r30 = diff(a, b, W, H, 30), rSame = diff(a, a, W, H, 0);
    const hc = (r, x, y) => [].slice.call(r.heat.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    const ok1 = r0.changed === 105 && r30.changed === 100 && r0.maxD === 100 && Math.abs(r0.pct - 1.3125) < 1e-9 && rSame.changed === 0 && rSame.maxD === 0 &&
      hc(r0, 35, 15)[0] === 255 && hc(r0, 35, 15)[2] < 30 && hc(r0, 60, 60)[0] === hc(r0, 60, 60)[2] && fmtPct(r0.pct) === "1.31%";
    // different sizes through real canvases: 100x80 vs 90x60 aligned top-left -> 100*80 - 90*60 uncovered pixels differ
    const ia = canvas(100, 80), ib = canvas(90, 60);
    [ia, ib].forEach(c => { const x = c.getContext("2d"); x.fillStyle = "rgb(10,120,200)"; x.fillRect(0, 0, c.width, c.height); });
    const sz = alignSize(100, 80, 90, 60, "tl"), pa = placed(ia, 100, 80, sz.W, sz.H, "tl"), pb = placed(ib, 90, 60, sz.W, sz.H, "tl", true);
    const rd = diff(pa.getContext("2d").getImageData(0, 0, sz.W, sz.H).data, pb.getContext("2d").getImageData(0, 0, sz.W, sz.H).data, sz.W, sz.H, 0);
    const big = canvas(120, 90); big.getContext("2d").fillStyle = "#000"; big.getContext("2d").fillRect(0, 0, 120, 90);
    const sc = alignSize(100, 80, 120, 90, "center"), st2 = alignSize(100, 80, 120, 90, "stretch");
    const ps = placed(big, 120, 90, st2.W, st2.H, "stretch", true), psd = ps.getContext("2d").getImageData(99, 79, 1, 1).data;
    const ok2 = sz.W === 100 && sz.H === 80 && rd.changed === 100 * 80 - 90 * 60 && sc.W === 120 && sc.H === 90 && st2.W === 100 && st2.H === 80 && psd[3] === 255;
    return (ok1 && ok2) || { ok1, ok2, r0: r0.changed, r30: r30.changed, maxD: r0.maxD, rd: rd.changed };
  };
})();
