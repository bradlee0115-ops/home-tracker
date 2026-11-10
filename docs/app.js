(async function () {
  const $ = (id) => document.getElementById(id);
  const get = async (f, d) => { try { const r = await fetch(`data/${f}?v=${Date.now()}`); return r.ok ? r.json() : d; } catch { return d; } };
  const [cx, trades, meta, weekly] = await Promise.all([
    get("complexes.json", []), get("trades.json", []), get("meta.json", {}), get("weekly.json", null)]);

  const eok = (man) => {               // 만원 → "13억 9,000"
    const e = Math.floor(man / 10000), r = man % 10000;
    return e ? `${e}억${r ? " " + r.toLocaleString("ko-KR") : ""}` : `${r.toLocaleString("ko-KR")}만`;
  };
  const py = (a) => Math.round(a / 3.3058);
  const typ = (a) => Math.floor(a);                       // 전용면적 타입(59, 84 …)
  const short = (man) => `${+(man / 10000).toFixed(2)}억`; // 162500 → 16.25억
  const SIZES = [["전체", () => true], ["59㎡ 이하", (a) => a < 60], ["60~85㎡", (a) => a >= 60 && a < 86], ["85㎡ 초과", (a) => a >= 86]];
  let size = "전체";
  document.querySelector(".cx thead th:nth-child(5)").textContent = "타입별 최근 실거래";
  document.head.insertAdjacentHTML("beforeend", `<style>
    .types{display:grid;grid-template-columns:auto auto auto;justify-content:end;gap:2px 10px;align-items:baseline}
    .types .t{color:var(--muted);font-size:.8rem}.types .d{color:var(--muted);font-size:.8rem}
    .chips+.chips{margin-left:8px;padding-left:8px;border-left:1px solid var(--line)}</style>`);
  const day = (s) => new Date(s + "T00:00:00+09:00");
  const today = new Date();
  const daysAgo = (s) => (today - day(s)) / 86400000;
  const live = trades.filter((t) => !t.cancel);

  // 헤더
  $("updated").textContent = meta.updated_at
    ? `마지막 갱신 ${meta.updated_at.replace("T", " ")} · 최근 ${meta.months}개월 실거래 ${trades.length.toLocaleString()}건`
    : "아직 데이터가 없습니다. GitHub Actions에서 'Update data'를 한 번 실행하세요.";

  // 새로 신고된 거래: 첫 수집일 이후 7일 안에 처음 보인 관심 단지 거래
  const firstRun = meta.first_run || "9999-12-31";
  const fresh = trades.filter((t) => t.complex && t.first_seen > firstRun && daysAgo(t.first_seen) <= 7);
  $("new-hint").textContent = meta.first_run
    ? "최근 7일 동안 새로 공개된 관심 단지의 실거래입니다."
    : "첫 수집 이후부터 새로 공개되는 거래가 여기에 쌓입니다.";
  $("ledger").innerHTML = fresh.length
    ? fresh.slice(0, 30).map((t) => `<li>
        <span class="when">계약 ${t.date.slice(5).replace("-", "/")}</span>
        <span class="what"><b>${t.complex}</b><span>전용 ${t.area}㎡(${py(t.area)}평) · ${t.floor}층</span></span>
        <span class="price${t.cancel ? " cancel" : ""}">${eok(t.price)}</span></li>`).join("")
    : `<li><span class="empty">${meta.first_run ? "최근 7일 동안 새로 공개된 거래가 없습니다." : "첫 수집이 끝나면 다음 날부터 새 거래가 표시됩니다."}</span></li>`;

  // 관심 단지 표
  const regions = ["전체", ...new Set(cx.map((c) => c.region))];
  let sel = "전체";
  const byCx = {};
  for (const t of trades) if (t.complex) (byCx[t.complex] ||= []).push(t);

  function renderChips() {
    $("chips").innerHTML = `<div class="chips" role="group" aria-label="지역">` + regions.map((r) =>
      `<button type="button" aria-pressed="${r === sel}" data-r="${r}">${r}</button>`).join("") + `</div>`
      + `<div class="chips" role="group" aria-label="전용면적">` + SIZES.map(([k]) =>
      `<button type="button" aria-pressed="${k === size}" data-s="${k}">${k}</button>`).join("") + `</div>`;
    $("chips").querySelectorAll("button[data-r]").forEach((b) => b.onclick = () => { sel = b.dataset.r; renderChips(); renderTable(); });
    $("chips").querySelectorAll("button[data-s]").forEach((b) => b.onclick = () => { size = b.dataset.s; renderChips(); renderTable(); });
  }
  function renderTable() {
    const rows = cx.filter((c) => sel === "전체" || c.region === sel);
    $("cx-body").innerHTML = rows.map((c) => {
      const fit = SIZES.find(([k]) => k === size)[1];
      const ts = (byCx[c.name] || []).filter((t) => !t.cancel && fit(t.area));
      const n90 = ts.filter((t) => daysAgo(t.date) <= 90).length;
      const latest = {};                                   // 타입별 가장 최근 거래
      for (const t of ts) if (!latest[typ(t.area)]) latest[typ(t.area)] = t;
      const types = Object.keys(latest).map(Number).sort((a, b) => a - b);
      const shown = types.slice(0, 3);
      const cell = types.length
        ? `<div class="types">${shown.map((k) => { const t = latest[k];
            return `<span class="t">${k}㎡</span><b>${short(t.price)}</b><span class="d">${t.date.slice(5).replace("-", "/")}</span>`; }).join("")}</div>`
          + (types.length > 3 ? `<small>외 ${types.length - 3}개 타입</small>` : "")
        : "<small>최근 거래 없음</small>";
      const ask = c.min_ask ? (c.min_ask === c.max_ask ? `${c.min_ask}억` : `${c.min_ask}~${c.max_ask}억`) : "-";
      return `<tr tabindex="0" data-n="${c.name}">
        <td><b>${c.name}</b><br><small>${c.zone}</small></td><td>${c.dong}</td>
        <td>${c.built || "-"}년<br><small>${(c.households || 0).toLocaleString()}세대</small></td>
        <td><span class="tag">${(c.invest_class || c.age_class || "").split("(")[0]}</span></td>
        <td class="num">${cell}</td>
        <td class="num">${n90}건</td><td class="num">${ask}</td></tr>`;
    }).join("");
    $("cx-body").querySelectorAll("tr").forEach((tr) => {
      const open = () => showDetail(tr.dataset.n);
      tr.onclick = open; tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
  }

  // 단지 상세 + 차트
  let chart;
  const palette = ["#1E6A73", "#C23B22", "#2F5BB7", "#8A6D1F", "#6B4C9A"];
  function showDetail(name) {
    const c = cx.find((x) => x.name === name), ts = byCx[name] || [];
    $("detail").hidden = false;
    $("detail-h").textContent = name;
    $("detail-meta").textContent = `${c.gu} ${c.dong} · ${c.built}년 준공 · ${(c.households || 0).toLocaleString()}세대 · ${c.invest_class || ""}`;
    $("detail-body").innerHTML = ts.length ? ts.map((t) => `<tr class="${t.cancel ? "cancel" : ""}">
      <td>${t.date}</td><td>${t.area}㎡ (${py(t.area)}평)</td><td>${t.floor}층</td><td class="num">${eok(t.price)}</td></tr>`).join("")
      : `<tr><td colspan="4">이 기간에 연결된 실거래가 없습니다. 이름이 다르게 등록돼 있을 수 있으니 아래 '연결 안 된 단지명'을 확인하세요.</td></tr>`;
    const groups = {};
    for (const t of ts.filter((t) => !t.cancel)) (groups[typ(t.area) + "㎡"] ||= []).push({ x: day(t.date).getTime(), y: t.price / 10000 });
    if (chart) chart.destroy();
    if (window.Chart) {
      const css = getComputedStyle(document.documentElement);
      chart = new Chart($("chart"), {
        type: "scatter",
        data: { datasets: Object.entries(groups).map(([k, v], i) => ({ label: `전용 ${k}`, data: v, backgroundColor: palette[i % palette.length], pointRadius: 5 })) },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: css.getPropertyValue("--ink") } },
            tooltip: { callbacks: { label: (c) => `${new Date(c.raw.x).toISOString().slice(0, 10)} · ${c.raw.y.toFixed(2)}억` } } },
          scales: {
            x: { ticks: { color: css.getPropertyValue("--muted"), callback: (v) => new Date(v).toISOString().slice(2, 7).replace("-", ".") }, grid: { color: css.getPropertyValue("--line") } },
            y: { ticks: { color: css.getPropertyValue("--muted"), callback: (v) => v + "억" }, grid: { color: css.getPropertyValue("--line") } } } }
      });
    }
    $("detail").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  $("detail-close").onclick = () => { $("detail").hidden = true; };

  // 동별 흐름
  const dongs = [...new Set(cx.map((c) => c.dong))];
  const ppy = (ts) => ts.length ? ts.reduce((s, t) => s + t.price / (t.area / 3.3058), 0) / ts.length : null;
  $("dong-body").innerHTML = dongs.map((d) => {
    const ts = live.filter((t) => t.dong === d);
    const a = ts.filter((t) => daysAgo(t.date) <= 90), b = ts.filter((t) => daysAgo(t.date) > 90 && daysAgo(t.date) <= 180);
    const pa = ppy(a), pb = ppy(b), ch = pa && pb ? (pa / pb - 1) * 100 : null;
    return `<tr><td>${d}</td><td class="num">${ts.filter((t) => daysAgo(t.date) <= 30).length}건</td><td class="num">${a.length}건</td>
      <td class="num">${pa ? Math.round(pa).toLocaleString() + "만" : "-"}</td><td class="num">${pb ? Math.round(pb).toLocaleString() + "만" : "-"}</td>
      <td class="num ${ch > 0 ? "up" : ch < 0 ? "down" : ""}">${ch == null ? "-" : (ch > 0 ? "+" : "") + ch.toFixed(1) + "%"}</td></tr>`;
  }).join("");

  // 구별 주간
  if (weekly && Object.keys(weekly).length) {
    const gus = Object.keys(weekly), weeks = [...new Set(gus.flatMap((g) => weekly[g].map((x) => x.week)))].sort().slice(-8);
    $("wk-hint").textContent = "한국부동산원 주간 아파트 매매가격지수. 최근 8주.";
    $("wk-head").innerHTML = `<th scope="col">구</th>` + weeks.map((w) => `<th scope="col" class="num">${w}</th>`).join("");
    $("wk-body").innerHTML = gus.map((g) => `<tr><td>${g}</td>` + weeks.map((w) => {
      const v = (weekly[g].find((x) => x.week === w) || {}).value; return `<td class="num">${v ?? "-"}</td>`; }).join("") + "</tr>").join("");
  } else {
    document.querySelector("#weekly-sec .table-wrap").hidden = true;
    $("wk-hint").textContent = meta.weekly && meta.weekly.error ? meta.weekly.error
      : "주간 동향은 아직 설정되지 않았습니다. README의 '주간 동향 켜기'를 참고해 REB_API_KEY와 REB_STATBL_ID를 등록하세요.";
  }

  // 연결 안 된 단지명
  $("unmatched").innerHTML = (meta.unmatched || []).slice(0, 80).map((u) => `<li>${u.dong} ${u.apt} <small>(${u.count}건)</small></li>`).join("")
    || "<li>없음</li>";

  renderChips(); renderTable();
})();
