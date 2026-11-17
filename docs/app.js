(async function () {
  const $ = (id) => document.getElementById(id);
  const get = async (f, d) => { try { const r = await fetch(`data/${f}?v=${Date.now()}`); return r.ok ? r.json() : d; } catch { return d; } };
  const [cx, trades, meta, weekly, news, asks] = await Promise.all([
    get("complexes.json", []), get("trades.json", []), get("meta.json", {}), get("weekly.json", null), get("news.json", null), get("asks.json", null)]);
 
  const eok = (man) => {               // 만원 → "13억 9,000"
    const e = Math.floor(man / 10000), r = man % 10000;
    return e ? `${e}억${r ? " " + r.toLocaleString("ko-KR") : ""}` : `${r.toLocaleString("ko-KR")}만`;
  };
  const py = (a) => Math.round(a / 3.3058);
  const typ = (a) => Math.floor(a);                       // 전용면적 타입(59, 84 …)
  const short = (man) => `${+(man / 10000).toFixed(2)}억`; // 162500 → 16.25억
  const SIZES = [["전체", () => true], ["59㎡ 이하", (a) => a < 60], ["60~85㎡", (a) => a >= 60 && a < 86], ["85㎡ 초과", (a) => a >= 86]];
  let size = "전체";
  let unit = "㎡"; try { unit = localStorage.getItem("unit") || "㎡"; } catch (e) {}
  // 네이버처럼 버튼 하나로 ㎡ ↔ 평 전환. 버튼에는 '누르면 바뀔 단위'를 보여준다.
  const unitBtn = () => `<button type="button" class="unitbtn" data-u="toggle" aria-label="면적 단위 전환">↻ ${unit === "㎡" ? "평" : "㎡"}</button>`;
  function toggleUnit() {
    unit = unit === "㎡" ? "평" : "㎡"; try { localStorage.setItem("unit", unit); } catch (e) {}
    renderChips(); renderTable(); renderLedger(); if (!$("detail").hidden && openName) showDetail(openName, true);
  }
  document.head.insertAdjacentHTML("beforeend", `<style>.unitbtn{font:inherit;font-size:.85rem;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:4px 12px;border-radius:8px;cursor:pointer;margin-left:8px}</style>`);
  const cxBy = {}; for (const c of cx) cxBy[c.name] = c;
  // 국토부 실거래는 전용면적만 있어, 네이버처럼 공급면적 평수로 바꾸려면 매물 목록의 전용→공급 대응표를 쓴다.
  function supplyOf(name, area) {
    const c = cxBy[name], k = String(Math.floor(area));
    if (c && c.supply && c.supply[k]) return [c.supply[k], true];
    let ratio = 1.33;                                        // 대응표가 없으면 같은 단지 비율, 그것도 없으면 일반적인 비율로 추정
    if (c && c.supply) { const e = Object.entries(c.supply)[0]; if (e) ratio = e[1] / Number(e[0]); }
    return [area * ratio, false];
  }
  function sizeLabel(name, area) {
    if (unit === "㎡") return `${Math.floor(area)}㎡`;
    const [s, ok] = supplyOf(name, area);
    return `${ok ? "" : "약 "}${Math.round(s / 3.3058)}평`;
  }
  // 호가: docs/data/asks.json (아실 자동 수집 + 네이버 붙여넣기 보강). 없으면 기존 엑셀 값.
  const SRC = { asil: "아실", naver: "네이버", keep: "직전값", excel: "기존 엑셀", none: "" };
  const md = (d) => d ? d.slice(5).replace("-", "/") : "";
  const rng = (a, b) => a === b ? short(a) : `${+(a / 10000).toFixed(2)}~${short(b)}`;
  function askOf(c) {
    const a = asks && asks.complexes && asks.complexes[c.name];
    if (a) return a;
    return c.min_ask ? { src: "excel", min: c.min_ask * 10000, max: c.max_ask * 10000, types: [] } : { src: "none" };
  }
  function askCell(c) {
    const [lo, hi, a, cnt] = askFit(c);
    if (!a.min) return `-<br><small>15억↓ 매물 없음</small>`;
    if (lo == null) return `-<br><small>이 면적 매물 없음</small>`;
    const sub = a.src === "excel" ? SRC.excel
      : a.src === "keep" ? `${md(a.date)} 값 유지`
      : `${SRC[a.src]} ${md(a.date)} · ${cnt}건`;
    return `${rng(lo, hi)}<br><small>${sub}</small>`;
  }
  function askTypes(c) {
    const a = askOf(c);
    if (!a.types || !a.types.length) return a.src === "excel" ? `호가(기존 엑셀): ${rng(a.min, a.max)}` : "호가: 15억 이하 매물 없음";
    const lbl = a.src === "keep" ? `직전값 ${md(a.date)}` : `${SRC[a.src]} ${md(a.date)}`;
    return `호가(${lbl}, 15억 이하): ` + a.types.map((t) => `${sizeLabel(c.name, t.area)} ${rng(t.min, t.max)}(${t.n})`).join(" · ");
  }
  document.querySelector(".cx thead th:nth-child(7)").textContent = "호가(15억↓)";
  document.querySelector(".cx thead th:nth-child(5)").textContent = "타입별 최근 실거래";
  document.querySelector(".trades thead th:nth-child(2)").textContent = "면적";
  document.head.insertAdjacentHTML("beforeend", `<style>
    .types{display:grid;grid-template-columns:auto auto auto;justify-content:end;gap:2px 10px;align-items:baseline}
    .types .t{color:var(--muted);font-size:.8rem}.types .d{color:var(--muted);font-size:.8rem}
    .chips+.chips{margin-left:8px;padding-left:8px;border-left:1px solid var(--line)}
    .ledger .empty{grid-column:1/-1}</style>`);
  const day = (s) => new Date(s + "T00:00:00+09:00");
  const today = new Date();
  const daysAgo = (s) => (today - day(s)) / 86400000;
  const live = trades.filter((t) => !t.cancel);
 
  // 헤더
  $("updated").textContent = meta.updated_at
    ? `마지막 갱신 ${meta.updated_at.replace("T", " ").replace("+09:00", "")} · 최근 ${meta.months}개월 실거래 ${trades.length.toLocaleString()}건` + (asks ? (asks.asil && asks.asil.ok ? ` · 호가 아실 ${asks.asil.rows.toLocaleString()}건 수집` : ` · 호가 아실 수집 실패(직전값·엑셀 표시)`) + (asks.naver && asks.naver.fresh ? ` · 네이버 붙여넣기 ${asks.naver.date.slice(5).replace("-", "/")}` : "") : "")
    : "아직 데이터가 없습니다. GitHub Actions에서 'Update data'를 한 번 실행하세요.";
 
  // 새로 신고된 거래: 첫 수집일 이후 7일 안에 처음 보인 관심 단지 거래.
  // 아직 없으면 계약일 기준 최근 14일 거래를 대신 보여준다.
  const firstRun = meta.first_run || "9999-12-31";
  const row = (t) => `<li>
        <span class="when">계약 ${t.date.slice(5).replace("-", "/")}</span>
        <span class="what"><b>${t.complex}</b><span>${unit === "평" ? `${sizeLabel(t.complex, t.area)} (전용 ${Math.floor(t.area)}㎡)` : `전용 ${t.area}㎡`} · ${t.floor}층</span></span>
        <span class="price${t.cancel ? " cancel" : ""}">${eok(t.price)}</span></li>`;
  let fresh = trades.filter((t) => t.complex && t.first_seen > firstRun && daysAgo(t.first_seen) <= 7);
  if (fresh.length) {
    $("new-hint").textContent = "최근 7일 동안 새로 공개된 관심 단지의 실거래입니다.";
  } else {
    fresh = live.filter((t) => t.complex && daysAgo(t.date) <= 14);
    $("new-hint").textContent = "새로 공개된 거래가 쌓이기 전까지 계약일 기준 최근 14일 거래를 보여줍니다. 실거래는 계약 후 30일 안에 신고되므로 최근 거래일수록 아직 덜 반영돼 있습니다.";
  }
  // 새 거래: 지역·면적 탭 + 접기/펼치기 + 더보기
  const regionOf = {}; for (const c of cx) regionOf[c.name] = c.region;
  const allRegions = ["전체", ...new Set(cx.map((c) => c.region))];
  let lReg = "전체", lSize = "전체", lOpen = true, lAll = false;
  document.head.insertAdjacentHTML("beforeend", `<style>
    .hero .ledger li{padding:9px 0;grid-template-columns:6.5rem 1fr auto}
    .hero .ledger .price{font-size:1.15rem;font-weight:720}
    .hero .ledger .what{font-size:.92rem}.hero .ledger .what span{font-size:.82rem}
    .hero .ledger .when{font-size:.78rem}
    .hero-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
    .tog{font:inherit;font-size:.82rem;border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:6px;padding:3px 10px;cursor:pointer}
    .more{display:block;width:100%;margin:6px 0 12px;font:inherit;font-size:.85rem;background:transparent;border:1px dashed var(--line);border-radius:6px;padding:6px;color:var(--muted);cursor:pointer}
    .fbar{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px}
  </style>`);
  const hero = document.querySelector(".hero");
  const hh = document.createElement("div"); hh.className = "hero-head";
  $("new-h").replaceWith(hh); hh.appendChild(Object.assign(document.createElement("h2"), { id: "new-h", textContent: "" }));
  hh.insertAdjacentHTML("beforeend", `<button type="button" class="tog" id="ltog" aria-expanded="true">접기</button>`);
  $("new-hint").insertAdjacentHTML("afterend", `<div class="fbar" id="lchips"></div><div id="lbody"></div>`);
  $("lbody").appendChild($("ledger"));
  const chipRow = (label, opts, cur, key) => `<div class="chips" role="group" aria-label="${label}">` +
    opts.map((o) => `<button type="button" aria-pressed="${o === cur}" data-${key}="${o}">${o}</button>`).join("") + `</div>`;
  function renderLedger() {
    $("new-h").textContent = freshMode ? "새로 신고된 거래" : "최근 2주 계약된 거래";
    $("lchips").innerHTML = chipRow("지역", allRegions, lReg, "lr") + chipRow("전용면적", SIZES.map((s) => s[0]), lSize, "ls") + unitBtn();
    $("lchips").querySelector("button[data-u]").onclick = toggleUnit;
    $("lchips").querySelectorAll("[data-lr]").forEach((b) => b.onclick = () => { lReg = b.dataset.lr; lAll = false; renderLedger(); });
    $("lchips").querySelectorAll("[data-ls]").forEach((b) => b.onclick = () => { lSize = b.dataset.ls; lAll = false; renderLedger(); });
    const fit = SIZES.find(([k]) => k === lSize)[1];
    const list = fresh.filter((t) => (lReg === "전체" || regionOf[t.complex] === lReg) && fit(t.area));
    const shown = lAll ? list : list.slice(0, 6);
    $("ledger").innerHTML = shown.length ? shown.map(row).join("")
      : `<li><span class="empty">조건에 맞는 거래가 없습니다.</span></li>`;
    const old = $("lmore"); if (old) old.remove();
    if (list.length > 6) $("ledger").insertAdjacentHTML("afterend",
      `<button type="button" class="more" id="lmore">${lAll ? "접기" : `전체 ${list.length}건 보기`}</button>`);
    if ($("lmore")) $("lmore").onclick = () => { lAll = !lAll; renderLedger(); };
    $("lchips").hidden = $("lbody").hidden = $("new-hint").hidden = !lOpen;
    $("ltog").textContent = lOpen ? "접기" : `펼치기 (${list.length}건)`;
    $("ltog").setAttribute("aria-expanded", String(lOpen));
  }
  const freshMode = trades.some((t) => t.complex && t.first_seen > firstRun && daysAgo(t.first_seen) <= 7);
  $("ltog").onclick = () => { lOpen = !lOpen; renderLedger(); };
  renderLedger();
 
  // 관심 단지 표
  const regions = ["전체", ...new Set(cx.map((c) => c.region))];
  let sel = "전체";
  const byCx = {};
  for (const t of trades) if (t.complex) (byCx[t.complex] ||= []).push(t);
 
  function renderChips() {
    $("chips").innerHTML = `<div class="chips" role="group" aria-label="지역">` + regions.map((r) =>
      `<button type="button" aria-pressed="${r === sel}" data-r="${r}">${r}</button>`).join("") + `</div>`
      + `<div class="chips" role="group" aria-label="전용면적">` + SIZES.map(([k]) =>
      `<button type="button" aria-pressed="${k === size}" data-s="${k}">${k}</button>`).join("") + `</div>`
 + unitBtn();
    $("chips").querySelectorAll("button[data-r]").forEach((b) => b.onclick = () => { sel = b.dataset.r; renderChips(); renderTable(); });
    $("chips").querySelectorAll("button[data-s]").forEach((b) => b.onclick = () => { size = b.dataset.s; renderChips(); renderTable(); });
    $("chips").querySelectorAll("button[data-u]").forEach((b) => b.onclick = toggleUnit);
  }
  const projTag = {};
  if (news) for (const p of news.projects) {
    const n = p.ai ? p.ai.step_now : p.step_now;
    for (const c of p.complexes || []) projTag[c] = `${p.type} · ${(p.steps || [])[n] || ""}`;
  }
  // 표 정렬: 머리글(준공·최근 실거래·3개월 거래·호가)을 누를 때마다 오름차순 → 내림차순 → 기본 순서
  let sortKey = null, sortDir = 1;
  const SORTS = { 3: ["built", "준공·세대"], 5: ["deal", "타입별 최근 실거래"], 6: ["n90", "3개월 거래"], 7: ["ask", "호가(15억↓)"] };
  function askFit(c) {                       // 면적 필터에 맞는 평형만의 호가 범위
    const a = askOf(c), fit = SIZES.find(([k]) => k === size)[1];
    if (size === "전체" || !a.types || !a.types.length) return a.min ? [a.min, a.max, a, a.n] : [null, null, a, 0];
    const ts = a.types.filter((t) => fit(t.area));
    return ts.length ? [Math.min(...ts.map((t) => t.min)), Math.max(...ts.map((t) => t.max)), a, ts.reduce((s, t) => s + t.n, 0)] : [null, null, a, 0];
  }
  function metric(c) {
    const fit = SIZES.find(([k]) => k === size)[1];
    const ts = (byCx[c.name] || []).filter((t) => !t.cancel && fit(t.area));
    return { built: c.built || null, deal: ts.length ? ts[0].price : null,
             n90: ts.filter((t) => daysAgo(t.date) <= 90).length, ask: askFit(c)[0] };
  }
  function renderSortHead() {
    const ths = document.querySelectorAll(".cx thead th");
    for (const [i, [key, label]] of Object.entries(SORTS)) {
      const th = ths[i - 1]; if (!th) continue;
      const on = sortKey === key, arrow = on ? (sortDir > 0 ? " ▲" : " ▼") : " ↕";
      th.setAttribute("aria-sort", on ? (sortDir > 0 ? "ascending" : "descending") : "none");
      th.innerHTML = `<button type="button" class="sortbtn${on ? " on" : ""}" data-k="${key}">${label}<span aria-hidden="true">${arrow}</span></button>`;
    }
    document.querySelectorAll(".cx thead .sortbtn").forEach((b) => b.onclick = () => {
      const k = b.dataset.k;
      if (sortKey !== k) { sortKey = k; sortDir = 1; } else if (sortDir > 0) sortDir = -1; else sortKey = null;
      renderTable();
    });
  }
  document.head.insertAdjacentHTML("beforeend", `<style>.sortbtn{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;white-space:nowrap}.sortbtn span{opacity:.45;font-size:.8em}.sortbtn.on span{opacity:1;color:var(--accent,#1E6A73)}.sortbtn:focus-visible{outline:2px solid currentColor;outline-offset:2px}</style>`);
  function renderTable() {
    let rows = cx.filter((c) => sel === "전체" || c.region === sel);
    if (sortKey) {
      const m = new Map(rows.map((c) => [c.name, metric(c)[sortKey]]));
      rows = [...rows].sort((a, b) => {
        const x = m.get(a.name), y = m.get(b.name);
        if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;   // 값 없는 단지는 항상 맨 아래
        return (x - y) * sortDir;
      });
    }
    renderSortHead();
    parkDetail();
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
            return `<span class="t">${sizeLabel(c.name, t.area)}</span><b>${short(t.price)}</b><span class="d">${t.date.slice(5).replace("-", "/")}</span>`; }).join("")}</div>`
          + (types.length > 3 ? `<small>외 ${types.length - 3}개 타입</small>` : "")
        : "<small>최근 거래 없음</small>";
      const ask = askCell(c);
      return `<tr tabindex="0" data-n="${c.name}">
        <td><b>${c.name}</b><br><small>${c.zone}</small></td><td>${c.dong}</td>
        <td>${c.built || "-"}년<br><small>${(c.households || 0).toLocaleString()}세대</small></td>
        <td><span class="tag">${projTag[c.name] || (c.invest_class || c.age_class || "").split("(")[0]}</span></td>
        <td class="num">${cell}</td>
        <td class="num">${n90}건</td><td class="num">${ask}</td></tr>`;
    }).join("");
    $("cx-body").querySelectorAll("tr").forEach((tr) => {
      const open = () => (openName === tr.dataset.n && !$("detail").hidden ? closeDetail() : showDetail(tr.dataset.n));
      tr.onclick = open; tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
    if (openName && !$("detail").hidden) {     // 정렬·필터 후에도 열려 있던 단지 아래에 다시 붙임(목록에서 빠졌으면 닫음)
      if (mountDetail(openName)) { if (map) setTimeout(() => map.invalidateSize(), 0); } else closeDetail();
    }
  }
 
  // 단지 상세 + 차트
  let chart;
  const palette = ["#1E6A73", "#C23B22", "#2F5BB7", "#8A6D1F", "#6B4C9A"];
  let openName = null;
  // 상세 패널은 누른 행 바로 아래 펼침 행(tr.detail-row) 안으로 옮겨 보여준다.
  const detailHome = document.createElement("div"); detailHome.hidden = true;
  $("detail").before(detailHome);
  function parkDetail() {                      // 표를 다시 그리기 전에 상세 패널을 원래 자리로 되돌림
    const d = $("detail"); detailHome.after(d);
    document.querySelectorAll("tr.detail-row").forEach((r) => r.remove());
    document.querySelectorAll("#cx-body tr.open").forEach((r) => r.classList.remove("open"));
  }
  function mountDetail(name) {                 // 해당 단지 행 아래에 붙임. 행이 없으면(필터로 숨김) 원래 자리에 표시
    const row = [...document.querySelectorAll("#cx-body tr[data-n]")].find((r) => r.dataset.n === name);
    if (!row) return null;
    const tr = document.createElement("tr"); tr.className = "detail-row";
    const td = document.createElement("td"); td.colSpan = row.cells.length;
    tr.appendChild(td); row.after(tr); td.appendChild($("detail")); row.classList.add("open");
    return row;
  }
  // 지도: Leaflet + OpenStreetMap(키 불필요). 선택 단지는 큰 표시, 나머지 관심 단지는 작은 점.
  let map, mapLayer;
  function drawMap(c) {
    const box = $("map"), links = $("maplinks");
    const q = encodeURIComponent(`${c.gu} ${c.dong} ${c.name.replace(/\(.*?\)/, "")} 아파트`);
    links.innerHTML = `<a href="https://map.naver.com/p/search/${q}" target="_blank" rel="noopener">네이버 지도 ↗</a>`
      + (c.lat ? `<a href="https://map.kakao.com/link/map/${encodeURIComponent(c.name)},${c.lat},${c.lng}" target="_blank" rel="noopener">카카오맵 ↗</a>` : "")
      + `<a href="https://new.land.naver.com/search?ms=${c.lat || ""},${c.lng || ""},17&sk=${q}" target="_blank" rel="noopener">네이버 부동산 ↗</a>`;
    if (!window.L || !c.lat) { box.hidden = true; return; }
    box.hidden = false;
    if (!map) {
      map = L.map(box, { scrollWheelZoom: false, attributionControl: true });
      const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
      // 대중교통 지도(ÖPNVKarte): 지하철 노선·역이 잘 보임. 기본 지도는 OSM. 철도 노선은 겹쳐 보기 가능.
      const bases = {
        "대중교통 지도": L.tileLayer("https://tile.memomaps.de/tilegen/{z}/{x}/{y}.png",
          { maxZoom: 18, attribution: `${osm} · <a href="https://memomaps.de/">memomaps.de</a>` }),
        "기본 지도": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osm }),
      };
      const overlays = {
        "지하철·철도 노선 강조": L.tileLayer("https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png",
          { maxZoom: 19, attribution: `${osm} · <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>` }),
      };
      let pick = "대중교통 지도"; try { pick = localStorage.getItem("mapBase") || pick; } catch (e) {}
      (bases[pick] || bases["대중교통 지도"]).addTo(map);
      L.control.layers(bases, overlays, { collapsed: true }).addTo(map);
      map.on("baselayerchange", (e) => { try { localStorage.setItem("mapBase", e.name); } catch (er) {} });
      mapLayer = L.layerGroup().addTo(map);
    }
    mapLayer.clearLayers();
    for (const o of cx) {
      if (!o.lat || o.name === c.name) continue;
      L.circleMarker([o.lat, o.lng], { radius: 5, color: "#5B6875", weight: 1, fillColor: "#5B6875", fillOpacity: .55 })
        .bindTooltip(o.name, { className: "cxtip", direction: "top" })
        .on("click", () => showDetail(o.name)).addTo(mapLayer);
    }
    L.circleMarker([c.lat, c.lng], { radius: 10, color: "#fff", weight: 2, fillColor: "#C23B22", fillOpacity: 1 })
      .bindTooltip(c.name, { permanent: true, className: "cxtip", direction: "top", offset: [0, -8] }).addTo(mapLayer);
    setTimeout(() => { map.invalidateSize(); map.setView([c.lat, c.lng], 16); }, 0);
  }
  function showDetail(name, noScroll) {
    openName = name;
    const c = cx.find((x) => x.name === name), ts = byCx[name] || [];
    parkDetail();
    const row = mountDetail(name);
    $("detail").hidden = false;
    $("detail-h").textContent = name;
    $("detail-meta").textContent = `${c.gu} ${c.dong} · ${c.built}년 준공 · ${(c.households || 0).toLocaleString()}세대 · ${c.invest_class || ""}`;
    let ae = $("detail-asks"); if (!ae) { ae = document.createElement("p"); ae.id = "detail-asks"; ae.className = "meta"; $("detail-meta").after(ae); }
    ae.textContent = askTypes(c);
    $("detail-body").innerHTML = ts.length ? ts.map((t) => `<tr class="${t.cancel ? "cancel" : ""}">
      <td>${t.date}</td><td>${sizeLabel(name, t.area)}${unit === "평" ? ` <small>전용 ${t.area}㎡</small>` : ""}</td><td>${t.floor}층</td><td class="num">${eok(t.price)}</td></tr>`).join("")
      : `<tr><td colspan="4">이 기간에 연결된 실거래가 없습니다. 이름이 다르게 등록돼 있을 수 있으니 아래 '연결 안 된 단지명'을 확인하세요.</td></tr>`;
    const groups = {};
    for (const t of ts.filter((t) => !t.cancel)) (groups[sizeLabel(name, t.area)] ||= []).push({ x: day(t.date).getTime(), y: t.price / 10000 });
    if (chart) chart.destroy();
    if (window.Chart) {
      const css = getComputedStyle(document.documentElement);
      chart = new Chart($("chart"), {
        type: "scatter",
        data: { datasets: Object.entries(groups).map(([k, v], i) => ({ label: k, data: v, backgroundColor: palette[i % palette.length], pointRadius: 5 })) },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: css.getPropertyValue("--ink") } },
            tooltip: { callbacks: { label: (c) => `${new Date(c.raw.x).toISOString().slice(0, 10)} · ${c.raw.y.toFixed(2)}억` } } },
          scales: {
            x: { ticks: { color: css.getPropertyValue("--muted"), callback: (v) => new Date(v).toISOString().slice(2, 7).replace("-", ".") }, grid: { color: css.getPropertyValue("--line") } },
            y: { ticks: { color: css.getPropertyValue("--muted"), callback: (v) => v + "억" }, grid: { color: css.getPropertyValue("--line") } } } }
      });
    }
    drawMap(c);
    if (!noScroll) (row || $("detail")).scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  function closeDetail() { openName = null; $("detail").hidden = true; parkDetail(); }
  $("detail-close").onclick = closeDetail;
 
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
 
 
  // ── 정비사업 현황 + 지역 뉴스 ──
  document.head.insertAdjacentHTML("beforeend", `<style>
    .proj{display:grid;gap:12px}
    .pcard{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
    .pcard h3{font-size:1.02rem;margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .pcard .cx{color:var(--muted);font-size:.85rem;font-weight:400}
    .pcard .tag{display:inline-block;font-size:.72rem;padding:1px 8px;border-radius:4px;background:var(--river-soft);font-weight:500}
    .steps{display:flex;gap:4px;margin:12px 0 6px;flex-wrap:wrap}
    .steps span{font-size:.72rem;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
    .steps span.done{background:var(--river-soft);color:var(--ink);border-color:transparent}
    .steps span.now{background:var(--river);color:var(--paper);border-color:var(--river);font-weight:600}
    .pstage{font-size:.9rem;margin:2px 0}.pstage small{color:var(--muted)}
    .plist{list-style:none;padding:0;margin:10px 0 0;border-top:1px dashed var(--line)}
    .plist li{padding:6px 0;font-size:.88rem;display:flex;gap:10px;align-items:baseline}
    .plist .dd{color:var(--muted);font-size:.78rem;white-space:nowrap;font-variant-numeric:tabular-nums}
    .plist a{color:var(--ink);text-decoration:none}.plist a:hover{text-decoration:underline}
    .plist .src{color:var(--muted);font-size:.78rem;white-space:nowrap}
    .newb{font-size:.7rem;background:var(--up);color:#fff;border-radius:4px;padding:1px 6px}
    .ntabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .ntabs button{font:inherit;font-size:.85rem;border:1px solid var(--line);background:transparent;color:var(--ink);padding:4px 12px;border-radius:999px;cursor:pointer}
    .ntabs button[aria-pressed="true"]{background:var(--river);border-color:var(--river);color:var(--paper)}
    .nbox{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:6px 18px}
    .nbox .plist{border-top:0;margin:0}.nbox .plist li{border-bottom:1px solid var(--line);padding:9px 0}.nbox .plist li:last-child{border-bottom:0}
  </style>`);
  const esc = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const nlist = (items, n) => items.slice(0, n).map((x) => `<li><span class="dd">${x.date ? x.date.slice(5).replace("-", "/") : ""}</span>
      <a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.date && daysAgo(x.date) <= 7 ? ' <span class="newb">새 기사</span>' : ""}
      <span class="src">${esc(x.source)}</span></li>`).join("");
  const anchor = document.querySelector("#dong-h").closest("section");
  const projSec = document.createElement("section");
  projSec.innerHTML = `<h2>정비사업 현황</h2><p class="hint">관련 기사는 하루 두 번 자동으로 모이고, 새 기사가 생기면 기사 제목의 '통과·인가·선정·착공' 같은 완료 신호를 찾아 현재 단계를 자동으로 다시 판정합니다. 단계 구분은 고정이며, 판정 근거와 사람이 처음 확인한 기준을 함께 보여줍니다. 자동 판정은 틀릴 수 있으니 중요한 결정 전에는 원문 기사와 조합 공지를 확인하세요.${news && news.updated_at ? ` 기사 수집 ${news.updated_at.replace("T", " ").replace("+09:00", "")}` : ""}</p><div class="proj" id="proj"></div>`;
  anchor.before(projSec);
  const newsSec = document.createElement("section");
  newsSec.innerHTML = `<h2>지역 부동산 뉴스</h2><p class="hint">최근 2주 기사 제목과 링크입니다. 기사 원문은 각 언론사 사이트에서 확인하세요.</p><div class="ntabs" id="ntabs" role="group" aria-label="뉴스 분류"></div><div class="nbox"><ul class="plist" id="nlist"></ul></div>`;
  document.querySelector("details.unmatched").before(newsSec);
  if (!news) {
    $("proj").innerHTML = `<p class="hint">아직 수집된 기사가 없습니다. config/news.json을 올린 뒤 Actions에서 Update data를 실행하세요.</p>`;
    $("nlist").innerHTML = `<li>아직 수집된 기사가 없습니다.</li>`;
  } else {
    const pRegions = ["전체", ...new Set(news.projects.flatMap((p) => (p.complexes || []).map((c) => regionOf[c]).filter(Boolean)))];
    const pTypes = ["전체", ...new Set(news.projects.map((p) => p.type))];
    let pReg = "전체", pType = "전체";
    $("proj").insertAdjacentHTML("beforebegin", `<div class="fbar" id="pchips"></div>`);
    const drawProj = () => {
    $("pchips").innerHTML = chipRow("지역", pRegions, pReg, "pr") + chipRow("사업 유형", pTypes, pType, "pt");
    $("pchips").querySelectorAll("[data-pr]").forEach((b) => b.onclick = () => { pReg = b.dataset.pr; drawProj(); });
    $("pchips").querySelectorAll("[data-pt]").forEach((b) => b.onclick = () => { pType = b.dataset.pt; drawProj(); });
    const plist = news.projects.filter((p) => (pReg === "전체" || (p.complexes || []).some((c) => regionOf[c] === pReg)) && (pType === "전체" || p.type === pType));
    $("proj").innerHTML = plist.length ? plist.map((p) => {
      const fresh = (p.news || []).some((x) => x.date && daysAgo(x.date) <= 7);
      const ai = p.ai, cur = ai ? ai.step_now : p.step_now;
      const moved = ai && ai.changed_at && daysAgo(ai.changed_at) <= 14;
      return `<article class="pcard"><h3>${esc(p.name)} <span class="tag">${esc(p.type)}</span>${moved ? '<span class="newb">단계 변경</span>' : fresh ? '<span class="newb">새 기사</span>' : ""}
        <span class="cx">${(p.complexes || []).map(esc).join(" · ")}</span></h3>
        <div class="steps">${(p.steps || []).map((st, i) => `<span class="${i < cur ? "done" : i === cur ? "now" : ""}">${esc(st)}</span>`).join("")}</div>
        ${ai ? `<p class="pstage"><b>${esc(ai.stage)}</b> <small>(자동 판정 ${esc(ai.judged_at)} · ${esc(ai.confidence)}${ai.stage_date ? " · 기준 " + esc(ai.stage_date) : ""})</small></p>
          <p class="pstage"><small>근거: ${esc(ai.reason)}${moved ? ` · ${esc(p.steps[ai.changed_from] || "")} → ${esc(p.steps[ai.step_now] || "")}` : ""}</small></p>
          <p class="pstage"><small>최초 확인 기준: ${esc(p.stage)} (${esc(p.stage_date)} · ${esc(p.stage_source)})</small></p>`
        : `<p class="pstage"><b>${esc(p.stage)}</b> <small>(${esc(p.stage_date)} · ${esc(p.stage_source)})</small></p>`}
        <ul class="plist">${(p.news || []).length ? nlist(p.news, 3) : "<li><span class='dd'></span>최근 90일 관련 기사 없음</li>"}</ul></article>`;
    }).join("") : `<p class="hint">조건에 맞는 정비사업이 없습니다.</p>`;
    };
    drawProj();
    let tab = news.topics[0] ? news.topics[0].name : "";
    const drawTabs = () => {
      $("ntabs").innerHTML = news.topics.map((t) => `<button type="button" aria-pressed="${t.name === tab}" data-t="${esc(t.name)}">${esc(t.name)}</button>`).join("");
      $("ntabs").querySelectorAll("button").forEach((b) => b.onclick = () => { tab = b.dataset.t; drawTabs(); });
      const t = news.topics.find((x) => x.name === tab);
      $("nlist").innerHTML = t && t.news.length ? nlist(t.news, 15) : "<li>최근 2주 기사가 없습니다.</li>";
    };
    drawTabs();
  }
 
  renderChips(); renderTable();
})();
 
 
