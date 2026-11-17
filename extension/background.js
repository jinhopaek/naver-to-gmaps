// 서비스 워커: 장소 큐를 하나씩 처리한다.
// 상태는 chrome.storage.local 의 "run" 키에 저장하고, 팝업이 그것을 읽어 표시한다.

const BG_VERSION = "0.6.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 장소 사이 대기(ms). 너무 빠르면 구글 차단 페이지(/sorry/)가 뜰 수 있다.
// 차단되면 자동으로 멈추고, 잠시 뒤 '이어서'로 계속할 수 있다.
const MIN_GAP = 1000;
const MAX_GAP = 2500;

// 좌표 판정 기준(m)
const NEAREST_MAX = 250; // 검색 결과 여러 개 중 고를 때: 네이버 좌표에서 이 거리 안이어야 함
const DIRECT_MAX = 1000; // 바로 장소 페이지가 열렸을 때: 이보다 멀면 다른 장소로 보고 재검색

let stopRequested = false;

// ── 네이버 공유 목록 읽기 ────────────────────────────────────────────
// 네이버 엔드포인트는 Origin 이 chrome-extension:// 이면 403 을 준다.
// 확장(탭이 아닌 요청, tabId -1)이 보내는 요청에만 Origin 을 map.naver.com 으로 바꾼다.
const NAVER_API =
  "https://pages.map.naver.com/save-pages/api/maps-bookmark/v3/shares/{sid}/bookmarks?start=0&limit=5000&sort=lastUseTime";

async function ensureOriginRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Origin", operation: "set", value: "https://map.naver.com" }],
        },
        condition: {
          urlFilter: "||pages.map.naver.com/save-pages/",
          tabIds: [chrome.tabs.TAB_ID_NONE],
        },
      },
    ],
  });
}

async function loadNaverList(link) {
  let m = link.match(/folder\/([0-9a-f]{32})/);
  if (!m) {
    if (!/^https:\/\/(naver\.me|map\.naver\.com)\//.test(link)) {
      throw new Error("네이버 지도 공유 링크(naver.me/… 또는 map.naver.com/…)가 아닙니다.");
    }
    const res = await fetch(link, { redirect: "follow" });
    m = res.url.match(/folder\/([0-9a-f]{32})/);
  }
  if (!m) throw new Error("공유 폴더 ID를 찾지 못했습니다. '저장 목록 공유' 링크인지 확인하세요.");

  await ensureOriginRule();
  const res = await fetch(NAVER_API.replace("{sid}", m[1]));
  if (!res.ok) throw new Error(`네이버 응답 오류 (HTTP ${res.status})`);
  const data = await res.json();

  const all = data.bookmarkList || [];
  // 주소만 저장된 항목(type: address)은 구글 장소가 아니므로 제외
  const places = all
    .filter((b) => b.type !== "address" && b.name)
    .map((b) => ({
      name: b.displayName || b.name,
      address: b.address || "",
      lat: b.py, // 네이버 좌표(WGS84)
      lng: b.px,
    }));
  return {
    title: data.folder?.name || "",
    total: data.folder?.bookmarkCount ?? all.length,
    skipped: all.length - places.length,
    places,
  };
}

// ── 좌표 ────────────────────────────────────────────────────────────
// 구글지도는 장소 URL에 플러스 코드(예: !20s8Q99H276+FHJ)를 넣어 둔다. 이를 위경도로 바꾼다.
function decodePlus(code) {
  const A = "23456789CFGHJMPQRVWX";
  const c = String(code).toUpperCase().replace("+", "").replace(/0+$/, "");
  if (c.length < 8 || [...c].some((ch) => !A.includes(ch))) return null;
  let lat = -90, lng = -180, res = 20;
  const pairEnd = Math.min(c.length, 10);
  for (let i = 0; i < pairEnd; i += 2) {
    lat += A.indexOf(c[i]) * res;
    lng += A.indexOf(c[i + 1]) * res;
    if (i + 2 < pairEnd) res /= 20;
  }
  let hLat = res / 2, hLng = res / 2;
  if (c.length > 10) {
    let rLat = res, rLng = res;
    for (let i = 10; i < c.length; i++) {
      const d = A.indexOf(c[i]);
      rLat /= 5;
      rLng /= 4;
      lat += Math.floor(d / 4) * rLat;
      lng += (d % 4) * rLng;
    }
    hLat = rLat / 2;
    hLng = rLng / 2;
  }
  return { lat: lat + hLat, lng: lng + hLng };
}

function plusFromUrl(url) {
  const m = decodeURIComponent(url || "").match(/!20s([23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]*)/i);
  return m ? m[1] : null;
}

function distM(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

const norm = (s) => String(s || "").toLowerCase().replace(/[\s\-_.·,'"()]/g, "");
function nameMatch(a, b) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

// ── 실행 상태 ───────────────────────────────────────────────────────
const isDone = (s) => s === "SAVED" || s === "ALREADY_SAVED";
// 이번 회차에 처리할 개수(재시도면 실패했던 개수)
const runTotal = (run) => (run.order || run.places).length;

async function getRun() {
  return (await chrome.storage.local.get("run")).run;
}
async function setRun(patch) {
  // heartbeat: 진행 중일 때 마지막으로 살아 있던 시각. 멈춘 채 방치됐는지 판단하는 데 쓴다.
  const run = { ...(await getRun()), ...patch, heartbeat: Date.now() };
  await chrome.storage.local.set({ run });
  await updateBadge(run);
  return run;
}

// ── 확장 아이콘 배지(원형) ───────────────────────────────────────────
// 크롬 기본 배지는 모양을 바꿀 수 없어서, 아이콘 이미지 위에 원형 배지를 직접 그린다.
// 진행 중: 남은 개수(파랑) / 멈춤: "!"(빨강) / 완료: 체크(초록, 팝업을 열면 사라짐)
const HALT_TITLE = {
  CHALLENGE: "구글 로봇 확인 페이지가 떠서 멈췄습니다. 몇 분 뒤 '이어서'를 누르세요.",
  NOT_SIGNED_IN: "구글에 로그인돼 있지 않아 멈췄습니다.",
  LIST_NOT_FOUND: "저장할 목록 이름을 찾지 못해 멈췄습니다.",
  TAB_CLOSED: "작업 탭이 닫혀서 멈췄습니다. '이어서'를 누르세요.",
  INTERRUPTED: "브라우저나 확장이 재시작돼 멈췄습니다. '이어서'를 누르세요.",
  ERROR: "예상치 못한 오류로 멈췄습니다. '이어서'를 누르세요.",
};

const bitmaps = {};
async function baseBitmap(size) {
  if (!bitmaps[size]) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))).blob();
    bitmaps[size] = await createImageBitmap(blob);
  }
  return bitmaps[size];
}

async function drawIcon(badge) {
  if (!badge) {
    await chrome.action.setIcon({ path: { 16: "icons/icon16.png", 32: "icons/icon32.png" } });
    return;
  }
  // 툴바 아이콘은 16px밖에 안 되므로, 상태가 있을 때는 아이콘 전체를 원형 배지로 바꿔 최대한 크게 보인다.
  const imageData = {};
  for (const s of [16, 32]) {
    const cv = new OffscreenCanvas(s, s);
    const ctx = cv.getContext("2d");
    const cx = s / 2, cy = s / 2, r = s / 2;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = badge.color;
    ctx.fill();

    // 진행 중이면 가장자리에 진행률 고리(흰색)
    if (badge.progress != null && s >= 32) {
      const lw = s / 11;
      ctx.lineWidth = lw;
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath();
      ctx.arc(cx, cy, r - lw / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(cx, cy, r - lw / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, badge.progress));
      ctx.stroke();
    }

    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = "#FFFFFF";
    if (badge.kind === "check") {
      ctx.lineWidth = s / 7;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s * 0.27, s * 0.52);
      ctx.lineTo(s * 0.44, s * 0.69);
      ctx.lineTo(s * 0.74, s * 0.34);
      ctx.stroke();
    } else {
      const len = badge.text.length;
      const ring = badge.progress != null && s >= 32 ? 0.85 : 1;
      const fs = s * ring * (len >= 3 ? 0.5 : len === 2 ? 0.66 : 0.8);
      ctx.font = `bold ${fs}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(badge.text, cx, cy + fs * 0.06);
    }
    imageData[s] = ctx.getImageData(0, 0, s, s);
  }
  await chrome.action.setIcon({ imageData });
}

async function updateBadge(run) {
  let badge = null, title = "구글지도 목록으로 저장";
  if (run?.state === "running") {
    const total = runTotal(run);
    badge = {
      kind: "text",
      text: String(total - run.index),
      color: "#2F6BFF",
      progress: total ? run.index / total : 0,
    };
    title = `${run.round ? "실패 재시도" : "저장"} 중 — ${run.index}/${total}`;
  } else if (run?.state === "halted") {
    badge = { kind: "text", text: "!", color: "#D93025" };
    title = "멈춤: " + (HALT_TITLE[run.haltReason] || run.haltReason);
  } else if (run?.state === "done" && !run.seen) {
    badge = { kind: "check", color: "#1E8E3E" };
    title = "완료 — 팝업에서 결과를 확인하세요.";
  }
  await chrome.action.setBadgeText({ text: "" }); // 기본 사각 배지는 쓰지 않음
  await drawIcon(badge);
  await chrome.action.setTitle({ title });
}

// 진행 중으로 기록돼 있는데 실제로는 아무것도 돌고 있지 않으면(브라우저 재시작,
// 확장 새로고침, 서비스 워커 강제 종료 등) "멈춤"으로 바꿔 배지에 "!"를 띄운다.
let queueActive = false;
async function detectStaleRun() {
  const run = await getRun();
  if (run?.state === "running" && !queueActive) {
    await setRun({ state: "halted", haltReason: "INTERRUPTED" });
  } else {
    await updateBadge(run);
  }
}
chrome.runtime.onStartup.addListener(detectStaleRun);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("watchdog", { periodInMinutes: 1 });
  detectStaleRun();
});
chrome.alarms.onAlarm.addListener((a) => a.name === "watchdog" && detectStaleRun());

// ── 구글지도 검색 ───────────────────────────────────────────────────
// hl=en: UI를 영어로 고정해 버튼 라벨(Save, Save in your lists)이 언어와 무관하게 같도록 한다.
function searchUrl(p) {
  const q = [p.name, p.address].filter(Boolean).join(" ");
  return "https://www.google.com/maps/search/?api=1&hl=en&query=" + encodeURIComponent(q);
}
// 이름만으로, 네이버 좌표 주변을 검색
function nearUrl(p) {
  return `https://www.google.com/maps/search/${encodeURIComponent(p.name)}/@${p.lat},${p.lng},17z?hl=en`;
}

// ↓ 페이지 안에서 실행: 지금 화면이 장소 페이지인지, 결과 목록인지, 결과 없음인지 판별
// 영업 상태도 함께 읽는다: "perm"(폐업) / "temp"(임시 휴업) / null(영업 중으로 간주).
// "Closed ⋅ Opens 9 AM" 같은 '지금 영업시간 아님'은 폐업이 아니므로 감점하지 않는다.
function inspectPage() {
  const closedOf = (t) =>
    /permanently closed/i.test(t) ? "perm" : /temporarily closed/i.test(t) ? "temp" : null;
  if (location.pathname.includes("/maps/place/") && document.querySelector("h1")) {
    // 리뷰 본문에 섞인 단어를 잡지 않도록 화면 윗부분(이름·평점·영업 상태 줄)만 본다.
    const head = (document.querySelector('div[role="main"]')?.innerText || "").slice(0, 600);
    return {
      kind: "place",
      title: document.querySelector("h1").textContent.trim(),
      url: location.href,
      closed: closedOf(head),
    };
  }
  const links = [...document.querySelectorAll("a.hfpxzc")];
  if (links.length) {
    return {
      kind: "feed",
      results: links.map((a) => {
        const card = a.closest("div.Nv2PK") || a.parentElement;
        return {
          href: a.href,
          label: a.getAttribute("aria-label") || "",
          closed: closedOf(card?.innerText || ""),
        };
      }),
    };
  }
  const main = document.querySelector('div[role="main"]')?.innerText || "";
  if (/can't find|couldn't find|no results/i.test(main)) return { kind: "none" };
  return { kind: "loading" };
}

// 탭이 새 페이지로 바뀐 뒤, 장소 페이지/결과 목록/결과 없음 중 하나가 될 때까지 기다린다.
async function waitForPage(tabId, prevUrl, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.includes("/sorry/")) return { kind: "challenge" };
    if (tab.url && tab.url !== prevUrl && !tab.pendingUrl) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: inspectPage });
        if (result && result.kind !== "loading") return result;
      } catch {
        // 페이지 이동 중이면 주입이 실패할 수 있다. 다시 시도.
      }
    }
    await sleep(350);
  }
  return { kind: "none" };
}

async function go(tabId, url) {
  const prevUrl = (await chrome.tabs.get(tabId)).url;
  await chrome.tabs.update(tabId, { url });
  // 같은 주소로 다시 가는 경우엔 URL 변화가 없으므로 그대로 판별한다.
  return waitForPage(tabId, prevUrl === url ? null : prevUrl);
}

// 후보 점수(작을수록 좋음): 네이버 좌표와의 거리(m)
//  - 이름이 비슷하면 −100m (같은 건물에 가게가 여럿일 때 대비)
//  - 임시 휴업이면 +150m, 폐업이면 +1000m (근처에 영업 중인 곳이 있으면 항상 그쪽을 고름)
const CLOSED_PENALTY = { temp: 150, perm: 1000 };
const score = (r) => r.d - (r.nm ? 100 : 0) + (CLOSED_PENALTY[r.closed] || 0);

// 네이버 장소 하나를 구글 장소 페이지로 확정한다.
// 1) 이름+주소 검색 → 2) 이름만으로 네이버 좌표 주변 검색.
// 검색 결과가 여럿이면 '영업 중인지'와 '좌표가 가까운지'를 함께 보고 고른다.
// 고른 곳이 폐업이면 다음 방법으로 영업 중인 곳을 더 찾아보고, 끝내 없으면 폐업한 곳이라도 저장한다.
async function resolvePlace(tabId, p) {
  const hasCoord = p.lat != null && p.lng != null;
  const attempts = [{ url: searchUrl(p), method: "address" }];
  if (hasCoord) attempts.push({ url: nearUrl(p), method: "coord" });

  let lastFeed = 0;
  let fallback = null; // 폐업이라 일단 미뤄 둔 후보 { href, info }
  for (let k = 0; k < attempts.length; k++) {
    const a = attempts[k];
    const isLast = k === attempts.length - 1;
    let page = await go(tabId, a.url);
    if (page.kind === "challenge") return { status: "CHALLENGE" };

    if (page.kind === "feed") {
      lastFeed = page.results.length;
      if (!hasCoord) continue;
      const near = page.results
        .map((r) => ({ ...r, d: distM(p, decodePlus(plusFromUrl(r.href))), nm: nameMatch(p.name, r.label) }))
        .filter((r) => r.d != null && r.d <= NEAREST_MAX)
        .sort((x, y) => score(x) - score(y));
      if (!near.length) continue;
      const best = near[0];
      const info = {
        method: `${a.method}-nearest`,
        dist: best.d,
        candidates: page.results.length,
        closedSkipped: near.filter((r) => r !== best && r.closed && r.d < best.d).length,
      };
      if (best.closed === "perm" && !isLast) {
        fallback ??= { href: best.href, info };
        continue;
      }
      page = await go(tabId, best.href);
      if (page.kind === "challenge") return { status: "CHALLENGE" };
      if (page.kind !== "place") continue;
      return { ok: true, ...info, closed: page.closed || best.closed || null };
    }

    if (page.kind === "place") {
      const d = distM(p, decodePlus(plusFromUrl(page.url)));
      if (d != null && d > DIRECT_MAX) continue; // 너무 멀면 엉뚱한 장소. 다음 방법으로.
      const info = { method: a.method, dist: d };
      if (page.closed === "perm" && !isLast) {
        fallback ??= { href: page.url, info };
        continue;
      }
      return { ok: true, ...info, closed: page.closed || null };
    }
  }

  // 영업 중인 곳을 끝내 못 찾았으면, 미뤄 둔 폐업 장소라도 저장한다(결과에 '폐업' 표시).
  if (fallback) {
    const page = await go(tabId, fallback.href);
    if (page.kind === "challenge") return { status: "CHALLENGE" };
    if (page.kind === "place") return { ok: true, ...fallback.info, closed: "perm" };
  }
  return { status: lastFeed ? "NO_NEARBY_MATCH" : "NOT_FOUND" };
}

// ↓ 이 함수는 구글지도 페이지 안에서 실행된다(chrome.scripting). 외부 변수를 쓰면 안 된다.
async function saveInPage(listName) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, t) => {
    const end = Date.now() + t;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  };
  const escape = () =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  const title = await waitFor(() => document.querySelector("h1")?.textContent?.trim(), 8000);

  if (document.querySelector('a[href*="ServiceLogin"]')) {
    return { status: "NOT_SIGNED_IN", title };
  }

  const btn = await waitFor(
    () =>
      document.querySelector('button[aria-label^="Save"]') ||
      document.querySelector('button[aria-label^="Saved in"]'),
    10000,
  );
  if (!btn) return { status: "NO_SAVE_BUTTON", title };

  btn.click();
  const menu = await waitFor(
    () => document.querySelector('div[role="menu"][aria-label="Save in your lists"]'),
    6000,
  );
  if (!menu) return { status: "NO_MENU", title };

  // 메뉴 항목이 채워질 때까지 잠깐 기다린다.
  await waitFor(() => menu.querySelector('[role="menuitemradio"]'), 3000);
  const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
  const label = (el) => (el.innerText || el.textContent || "").split("\n")[0].trim();
  const item =
    items.find((el) => label(el) === listName) ||
    items.find((el) => (el.innerText || "").includes(listName));

  if (!item) {
    escape();
    return { status: "LIST_NOT_FOUND", title, lists: items.map(label) };
  }
  if (item.getAttribute("aria-checked") === "true") {
    escape();
    return { status: "ALREADY_SAVED", title };
  }

  item.click();
  // 고정 대기 대신, 체크 상태가 바뀌는 즉시 다음으로 넘어간다.
  const ok = await waitFor(() => item.getAttribute("aria-checked") === "true" || !item.isConnected, 3000);
  escape();
  return { status: ok ? "SAVED" : "SAVE_UNCONFIRMED", title };
}

// ── 큐 실행 ─────────────────────────────────────────────────────────
// 큐 실행을 감싸서, 탭이 닫히거나 예외가 나도 "진행 중"으로 남지 않고 "멈춤"이 되게 한다.
async function processQueue() {
  if (queueActive) return;
  queueActive = true;
  try {
    await setRun({ state: "running" }); // 배지를 바로 '진행 중'으로
    await runQueue();
  } catch (e) {
    const tabGone = /No tab with id|tab was closed/i.test(String(e));
    await setRun({ state: "halted", haltReason: tabGone ? "TAB_CLOSED" : "ERROR", error: String(e) });
  } finally {
    queueActive = false;
  }
}

async function runQueue() {
  stopRequested = false;
  let run = await getRun();
  let tabId = run.tabId;

  try {
    await chrome.tabs.get(tabId);
  } catch {
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    tabId = tab.id;
    run = await setRun({ tabId });
  }

  // order: 처리할 장소 번호 목록. 처음 실행은 전체, '실패만 다시 시도'는 실패한 번호만.
  const order = run.order || run.places.map((_, j) => j);
  for (let i = run.index; i < order.length; i++) {
    if (stopRequested) {
      await setRun({ state: "stopped" });
      return;
    }
    const pi = order[i];
    const p = run.places[pi];
    let result;

    const found = await resolvePlace(tabId, p);
    if (!found.ok) {
      result = found;
    } else {
      try {
        const [{ result: r }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: saveInPage,
          args: [run.listName],
        });
        const { ok, ...info } = found;
        result = { ...r, ...info };
      } catch (e) {
        result = { status: "SCRIPT_ERROR", error: String(e) };
      }
    }

    // 계속해도 의미 없는 오류는 전체 중단. 이 장소는 처리하지 않은 것으로 남겨 '이어서'에서 다시 한다.
    if (["CHALLENGE", "NOT_SIGNED_IN", "LIST_NOT_FOUND"].includes(result.status)) {
      await setRun({ state: "halted", haltReason: result.status, haltLists: result.lists || null, index: i });
      return;
    }

    const tab = await chrome.tabs.get(tabId);
    const entry = { i: pi, name: p.name, address: p.address, url: tab.url, ...result };
    run = await getRun();
    await setRun({ index: i + 1, log: [...run.log, entry] });
    await sleep(MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP));
  }
  await setRun({ state: "done" });
}

// ── 팝업과의 메시지 ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "ping") {
    // 팝업이 열릴 때마다 호출된다: 멈춘 채 방치된 작업을 점검하고, 완료 배지는 확인 처리.
    detectStaleRun()
      .then(getRun)
      .then((run) => (run?.state === "done" && !run.seen ? setRun({ seen: true }) : null))
      .finally(() => reply({ ok: true, version: BG_VERSION }));
    return true;
  }
  if (msg.type === "load") {
    loadNaverList(msg.link)
      .then((r) => reply({ ok: true, ...r }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true; // 비동기 응답
  }
  if (msg.type === "start") {
    chrome.storage.local
      .set({
        run: {
          state: "running", places: msg.places, listName: msg.listName,
          index: 0, log: [], startedAt: Date.now(), startIndex: 0, order: null, round: 0,
        },
      })
      .then(() => processQueue());
    reply({ ok: true });
  } else if (msg.type === "retryFailed") {
    // 실패한 장소만 골라 다시 처리한다. 성공 기록은 그대로 두고, 실패 기록은 지운 뒤 새 결과로 채운다.
    getRun()
      .then(async (run) => {
        if (!run?.places || run.state === "running") return;
        const idxOf = (e) =>
          e.i ?? run.places.findIndex((p) => p.name === e.name && p.address === e.address);
        const bad = run.log.filter((e) => !isDone(e.status));
        const order = [...new Set(bad.map(idxOf).filter((j) => j >= 0))];
        if (!order.length) return;
        await setRun({
          state: "running", order, index: 0, startIndex: 0, startedAt: Date.now(),
          round: (run.round || 0) + 1, haltReason: null, error: null, seen: false,
          log: run.log.filter((e) => isDone(e.status)),
        });
        await processQueue();
      });
    reply({ ok: true });
  } else if (msg.type === "resume") {
    getRun()
      .then((run) =>
        setRun({ state: "running", haltReason: null, error: null, startedAt: Date.now(), startIndex: run.index }),
      )
      .then(() => processQueue());
    reply({ ok: true });
  } else if (msg.type === "stop") {
    stopRequested = true;
    reply({ ok: true });
  }
});
