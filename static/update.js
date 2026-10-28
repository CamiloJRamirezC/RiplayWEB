"use strict";
/* Actualizar RiPlay desde GitHub. Usa `api`, `toast`, `el`, `$` de app.js. */

const upd = { info: null, job: null, polling: null, checking: false };
const updDlg = $("#upd-dialog");

const STEPS = [
  ["checking", "Buscando la versión nueva"],
  ["downloading", "Descargando desde GitHub"],
  ["verifying", "Verificando los archivos"],
  ["backup", "Guardando una copia de la versión actual"],
  ["installing", "Instalando"],
  ["libraries", "Actualizando librerías"],
  ["restarting", "Reiniciando RiPlay"],
];
const ROLLBACK_STEPS = [
  ["checking", "Restaurando la copia guardada"],
  ["libraries", "Actualizando librerías"],
  ["restarting", "Reiniciando RiPlay"],
];

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }) + ", " +
    d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

/* ------------------------------------------------------------ estado */

function updRenderBadge() {
  const info = upd.info;
  const st = info && info.status;
  const short = (st && st.upToDate && st.latest && st.latest.short) || (info && info.installedShort);
  $("#app-version-text").textContent = short ? `RiPlay · versión ${short}` : "RiPlay · buscar actualizaciones";
  const available = !!(st && !st.upToDate);
  $("#update-dot").hidden = !available;
  $("#app-version").title = available ? "Hay una actualización disponible" : "Buscar actualizaciones";
}

async function updCheck(refresh) {
  upd.checking = true;
  if (updDlg.open) updRender();
  try {
    upd.info = await api("update/status" + (refresh ? "?refresh=1" : ""), { timeout: 90000 });
  } catch (err) {
    upd.info = { error: err.message };
  }
  upd.checking = false;
  updRenderBadge();
  if (updDlg.open) {
    if (!$("#upd-form").contains(document.activeElement)) updFillForm(); // sin pisar lo que se está escribiendo
    updRender();
  }
}

/* ------------------------------------------------------------ diálogo */

function updOpen() {
  if (updDlg.open) return;
  if (upd.job && ["done", "error"].includes(upd.job.stage)) upd.job = null; // resultado viejo
  updDlg.showModal();
  updFillForm();
  updRender();
  if (!upd.job) updCheck(true);
}

function updFillForm() {
  const info = upd.info || {};
  $("#upd-repo").value = info.repo || "";
  $("#upd-branch").value = info.branch || "";
  $("#upd-token").value = "";
  $("#upd-token-state").textContent = info.hasToken ? "(guardado; dejalo vacío para no cambiarlo)" : "(opcional)";
  $("#upd-clear-token").hidden = !info.hasToken;
}

function updRender() {
  const box = $("#upd-content");
  const job = upd.job;
  const running = job && !["done", "error"].includes(job.stage);

  if (running || (job && job.stage === "done")) {
    const all = job.kind === "rollback" ? ROLLBACK_STEPS : STEPS;
    const idx = all.findIndex(([id]) => id === job.stage);
    const steps = all.filter(([id]) => id !== "libraries" || job.stage === "libraries");
    const title = job.kind === "rollback" ? "Volviendo a la versión anterior" : "Actualizando RiPlay";
    const list = el("ol", { class: "upd-steps" }, steps.map(([id, label]) => {
      const i = all.findIndex(([x]) => x === id);
      const cls = job.stage === "done" || i < idx ? "done" : i === idx ? "now" : "";
      return el("li", { class: cls }, (cls === "done" ? "✓ " : cls === "now" ? "• " : "  ") + label);
    }));
    const children = [el("p", { class: "upd-state", text: job.stage === "done" ? "Listo" : title }), list];
    if (job.stage === "done" && job.needsManualRestart) {
      children.push(el("p", { class: "upd-meta", text: "Para usar la versión nueva, cerrá la ventana negra de RiPlay y abrí de nuevo iniciar.bat." }));
    } else if (job.stage === "done") {
      children.push(el("p", { class: "upd-meta", text: "Ya tenías todo al día." }));
    }
    box.replaceChildren(...children);
    return;
  }

  if (upd.checking && !upd.info) return box.replaceChildren(el("p", { class: "upd-meta", text: "Buscando en GitHub…" }));
  const info = upd.info || {};
  const children = [];
  if (job && job.stage === "error") children.push(el("div", { class: "error-box", text: job.error }));

  if (info.error) {
    children.push(el("div", { class: "error-box", text: info.error }));
    if (info.needsToken) {
      $("#upd-advanced").open = true;
      children.push(el("p", { class: "upd-meta", text: "Cargá el token abajo y tocá “Guardar y buscar”." }));
    }
    children.push(el("div", { class: "dialog-actions" },
      el("button", { class: "btn", onclick: () => updCheck(true) }, upd.checking ? "Buscando…" : "Buscar de nuevo")));
  } else if (info.status) {
    const st = info.status;
    if (st.upToDate) {
      children.push(el("p", { class: "upd-state", text: "RiPlay está actualizado" }),
        el("p", { class: "upd-meta", text: `Versión ${st.latest.short} · ${st.latest.message || ""}` }),
        el("p", { class: "upd-meta", text: `Publicada el ${fmtDate(st.latest.date)} en ${st.repo} (${st.branch}).` }));
    } else {
      const n = st.changed.length;
      children.push(el("p", { class: "upd-state", text: "Hay una actualización" }),
        el("p", { class: "upd-meta", text: `Versión ${st.latest.short}, del ${fmtDate(st.latest.date)} · ${n} ${n === 1 ? "archivo cambia" : "archivos cambian"}.` }));
      if (st.commits && st.commits.length) {
        children.push(el("p", { class: "upd-meta", text: info.installed ? "Novedades:" : "Últimos cambios publicados:" }),
          el("ul", { class: "upd-changes" }, st.commits.map((c) =>
            el("li", {}, c.message || c.sha, " ", el("small", { text: `(${c.sha})` })))));
      }
      children.push(el("p", { class: "upd-meta", text: "Tus listas, favoritos, historial, descargas y ajustes no se tocan. Se guarda una copia de la versión actual por si querés volver." }));
    }
    children.push(el("div", { class: "dialog-actions" },
      info.hasBackup ? el("button", { class: "btn", onclick: updRollback }, "Volver a la versión anterior") : null,
      el("button", { class: "btn", onclick: () => updCheck(true) }, upd.checking ? "Buscando…" : "Buscar de nuevo"),
      st.upToDate ? null : el("button", { class: "btn primary", id: "upd-apply", onclick: updApply }, "Actualizar ahora")));
  } else {
    children.push(el("p", { class: "upd-meta", text: "Buscando en GitHub…" }));
  }
  box.replaceChildren(...children);
}

/* ------------------------------------------------------------ actualizar */

async function updApply() {
  try {
    upd.job = await api("update/apply", { method: "POST", body: {} });
    updRender();
    updPoll();
  } catch (err) { toast(err.message); }
}

async function updRollback() {
  if (!confirm("¿Volver a la versión anterior de RiPlay? Tus datos no se tocan.")) return;
  try {
    upd.job = await api("update/rollback", { method: "POST", body: {} });
    updRender();
    updPoll();
  } catch (err) { toast(err.message); }
}

function updPoll() {
  clearTimeout(upd.polling);
  upd.polling = setTimeout(async () => {
    if (upd.job && upd.job.stage === "restarting") return updWaitRestart();
    try { upd.job = await api("update/job"); } catch { /* reintenta */ }
    updRender();
    if (upd.job && ["done", "error"].includes(upd.job.stage)) {
      if (upd.job.stage === "done") updCheck(false);
      return;
    }
    updPoll();
  }, 600);
}

// El servicio se reinicia: esperar a que vuelva y recargar la página con la versión nueva
async function updWaitRestart() {
  updRender();
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 2500));
  while (Date.now() - started < 120000) {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (r.ok) {
        const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
        if (reg) await reg.update().catch(() => {});
        location.replace("/?actualizado=1");
        return;
      }
    } catch { /* todavía reiniciando */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  upd.job = { stage: "error", error: "RiPlay tarda en volver. Abrí iniciar.bat; si no arranca, mirá riplay.log." };
  updRender();
}

/* ------------------------------------------------------------ eventos */

$("#app-version").addEventListener("click", updOpen);
$("#upd-close").addEventListener("click", () => updDlg.close());
updDlg.addEventListener("click", (e) => { if (e.target === updDlg) updDlg.close(); });
$("#upd-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    upd.info = await api("update/config", { method: "POST", body: {
      repo: $("#upd-repo").value.trim(), branch: $("#upd-branch").value.trim(), token: $("#upd-token").value.trim(),
    } });
    updFillForm();
    toast("Guardado");
    updCheck(true);
  } catch (err) { toast(err.message); }
});
$("#upd-clear-token").addEventListener("click", async () => {
  try {
    upd.info = await api("update/config", { method: "POST", body: {
      repo: $("#upd-repo").value.trim(), branch: $("#upd-branch").value.trim(), clearToken: true,
    } });
    updFillForm();
    toast("Token quitado");
  } catch (err) { toast(err.message); }
});

(function updInit() {
  const params = new URLSearchParams(location.search);
  if (params.get("actualizado") === "1") {
    history.replaceState(null, "", "/");
    toast("RiPlay se actualizó");
  }
  if (params.get("vista") === "actualizar") {
    history.replaceState(null, "", "/");
    updOpen();
  } else {
    updCheck(false); // usa la última consulta (se repite cada 6 horas)
  }
})();
