/* RaceBuddy – immagine del risultato da condividere (storia 1080×1920 o quadrato 1080×1080).
   Disegna tutto su un canvas, sul telefono: niente va online. Funziona anche in Node (con node-canvas) per le prove. */
(function (root) {
  "use strict";

  const STILI = {
    blu: { fondo: "#1E2B4A", testo: "#FFFFFF", tenue: "#C9D2E3", accento: "#FF8A5C", badgeFondo: "#FF8A5C", badgeTesto: "#1E2B4A" },
    arancio: { fondo: "#C2410C", testo: "#FFFFFF", tenue: "#FDE3D6", accento: "#FFFFFF", badgeFondo: "#1E2B4A", badgeTesto: "#FFFFFF" },
    chiaro: { fondo: "#F3F5F7", testo: "#10161F", tenue: "#5A6472", accento: "#C2410C", badgeFondo: "#C2410C", badgeTesto: "#FFFFFF" },
    foto: { fondo: "#10161F", testo: "#FFFFFF", tenue: "#E2E7EF", accento: "#FF8A5C", badgeFondo: "#FF8A5C", badgeTesto: "#1E2B4A" },
  };
  const FORMATI = { storia: [1080, 1920], quadrato: [1080, 1080] };
  const DISPLAY = '"Barlow Condensed", "Arial Narrow", sans-serif', BODY = '"Barlow", "Helvetica Neue", sans-serif';

  // Divide un testo in righe che stanno in `max` pixel (al massimo `righe`, l'ultima con i puntini).
  function aCapo(ctx, testo, max, righe) {
    const parole = String(testo || "").split(/\s+/).filter(Boolean), out = [];
    let r = "";
    for (const p of parole) {
      const prova = r ? `${r} ${p}` : p;
      if (ctx.measureText(prova).width <= max || !r) r = prova;
      else { out.push(r); r = p; }
    }
    if (r) out.push(r);
    if (out.length > righe) {
      const tagliate = out.slice(0, righe);
      let ultima = tagliate[righe - 1];
      while (ultima && ctx.measureText(ultima + "…").width > max) ultima = ultima.replace(/\s*\S+$/, "");
      tagliate[righe - 1] = (ultima || "") + "…";
      return tagliate;
    }
    return out;
  }

  // Disegna l'immagine "a riempire" (cover) tenendo al centro il punto di fuoco [fx, fy] (frazioni 0-1).
  function copri(ctx, img, W, H, fuoco) {
    const iw = img.width, ih = img.height, s = Math.max(W / iw, H / ih);
    const w = iw * s, h = ih * s, [fx, fy] = fuoco || [0.5, 0.5];
    const x = Math.min(0, Math.max(W - w, W / 2 - fx * w)), y = Math.min(0, Math.max(H - h, H / 2 - fy * h));
    ctx.drawImage(img, x, y, w, h);
  }

  function rettangoloTondo(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /**
   * d: { gara, sottotitolo, tempo, badge?, posizione?, frase?, credito? }
   * o: { formato: "storia"|"quadrato", stile: "blu"|"arancio"|"chiaro"|"foto", immagine?, fuoco? }
   */
  function disegna(ctx, d, o) {
    const [W, H] = FORMATI[o.formato] || FORMATI.storia, q = o.formato === "quadrato";
    const st = STILI[o.immagine ? "foto" : o.stile] || STILI.blu, pad = q ? 80 : 96, larg = W - 2 * pad;
    ctx.save();
    ctx.fillStyle = st.fondo; ctx.fillRect(0, 0, W, H);
    if (o.immagine) {
      copri(ctx, o.immagine, W, H, o.fuoco);
      // velo scuro per leggere il testo: più forte in alto, dove stanno le scritte, leggero in basso
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "rgba(16,22,31,0.86)"); g.addColorStop(q ? 0.7 : 0.58, "rgba(16,22,31,0.62)"); g.addColorStop(1, "rgba(16,22,31,0.25)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    ctx.textBaseline = "alphabetic";
    const yLogo = q ? 128 : 168;
    ctx.fillStyle = st.accento; ctx.font = `700 ${q ? 52 : 60}px ${DISPLAY}`; ctx.fillText("RaceBuddy", pad, yLogo);

    // Il blocco del risultato: si misura una volta (vero = false), poi si disegna. Con la foto sta in alto, sopra
    // il velo più scuro; a tinta unita si centra nello spazio tra il logo e il fondo.
    const blocco = (y0, vero) => {
      let y = y0;
      ctx.fillStyle = st.tenue; ctx.font = `700 ${q ? 32 : 38}px ${BODY}`;
      if ("letterSpacing" in ctx) ctx.letterSpacing = "4px";
      if (vero) ctx.fillText(String(d.sottotitolo || "").toUpperCase(), pad, y);
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
      const fGara = q ? 100 : 124;
      ctx.fillStyle = st.testo; ctx.font = `700 ${fGara}px ${DISPLAY}`;
      for (const r of aCapo(ctx, d.gara, larg, 2)) { y += fGara; if (vero) ctx.fillText(r, pad, y); }
      const fTempo = q ? 250 : 310;
      y += fTempo * (q ? 0.92 : 0.98);
      ctx.fillStyle = st.accento; ctx.font = `700 ${fTempo}px ${DISPLAY}`; if (vero) ctx.fillText(d.tempo, pad - fTempo * 0.03, y);
      if (d.badge) {
        const fB = q ? 40 : 46;
        ctx.font = `700 ${fB}px ${BODY}`;
        const w = ctx.measureText(d.badge).width + fB * 1.4, h = fB * 1.75;
        y += q ? 44 : 56;
        if (vero) { ctx.fillStyle = st.badgeFondo; rettangoloTondo(ctx, pad, y, w, h, h / 2); ctx.fill(); ctx.fillStyle = st.badgeTesto; ctx.fillText(d.badge, pad + fB * 0.7, y + h * 0.68); }
        y += h;
      }
      if (d.posizione) {
        const fP = q ? 40 : 48;
        y += fP * 1.6; ctx.fillStyle = st.testo; ctx.font = `600 ${fP}px ${BODY}`; if (vero) ctx.fillText(d.posizione, pad, y);
      }
      if (d.frase) {
        const fF = q ? 40 : 52;
        ctx.fillStyle = st.testo; ctx.font = `500 ${fF}px ${BODY}`;
        y += q ? 30 : 50;
        for (const r of aCapo(ctx, `«${d.frase}»`, larg, q ? 2 : 4)) { y += fF * 1.32; if (vero) ctx.fillText(r, pad, y); }
      }
      return y;
    };
    const inizio = yLogo + (q ? 120 : 250);
    let y0 = inizio;
    if (!o.immagine) {
      const fine = blocco(inizio, false), alto = fine - inizio, spazio = H - (q ? 96 : 128) - (yLogo + 40);
      y0 = Math.max(inizio, yLogo + 40 + (spazio - alto) / 2 + (q ? 32 : 38));
    }
    blocco(y0, true);
    if (d.credito) {
      ctx.fillStyle = st.tenue; ctx.font = `500 ${q ? 24 : 28}px ${BODY}`; ctx.fillText(d.credito, pad, H - (q ? 48 : 64));
    }
    ctx.restore();
    return [W, H];
  }

  const api = { disegna, aCapo, copri, STILI, FORMATI };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RBImmagine = api;
})(typeof self !== "undefined" ? self : this);
