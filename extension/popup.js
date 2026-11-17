const $ = (id) => document.getElementById(id);
let places = [];
let lastRun = null;
let filter = "all";

const EXPECTED = "0.6.1";
const RELOAD_MSG = "chrome://extensions 에서 이 확장의 새로고침(↻)을 누른 뒤 팝업을 다시 여세요.";

const STATUS_KO = {
  SAVED: "저장됨",
  ALREADY_SAVED: "이미 저장돼 있음",
  SAVE_UNCONFIRMED: "눌렀지만 저장 확인 안 됨",
  NOT_SINGLE_RESULT: "검색 결과가 하나로 안 좁혀짐",
  NO_NEARBY_MATCH: "네이버 위치 근처(250m)에 맞는 곳이 없음",
  NOT_FOUND: "구글지도에서 찾지 못함",
  NO_SAVE_BUTTON: "저장 버튼을 못 찾음",
  NO_MENU: "목록 메뉴가 안 열림",
  LIST_NOT_FOUND: "목록 이름을 못 찾음",
  NOT_SIGNED_IN: "구글에 로그인돼 있지 않음",
  CHALLENGE: "구글 로봇 확인 페이지가 뜸",
  SCRIPT_ERROR: "스크립트 오류",
  TAB_CLOSED: "작업 탭이 닫힘",
  INTERRUPTED: "브라우저·확장 재시작으로 중단",
  ERROR: "예상치 못한 오류",
};
const HALT_HELP = {
  CHALLENGE: "구글이 로봇 확인 페이지를 띄웠습니다. 몇 분 쉬었다가 '이어서'를 누르세요.",
  NOT_SIGNED_IN: "Chrome에서 구글에 로그인한 뒤 '이어서'를 누르세요.",
  LIST_NOT_FOUND: "구글지도에 그 이름의 목록이 없습니다. 목록 이름을 확인하세요.",
  TAB_CLOSED: "작업 탭이 닫혔습니다. '이어서'를 누르면 새 탭에서 계속합니다.",
  INTERRUPTED: "브라우저나 확장이 재시작돼 끊겼습니다. '이어서'를 누르세요.",
  ERROR: "예상치 못한 오류로 멈췄습니다. '이어서'를 누르세요.",
};
const isOk = (s) => s === "SAVED";
const isSkip = (s) => s === "ALREADY_SAVED";
// 이번 회차에 처리할 개수(재시도면 실패했던 개수)
const runTotal = (run) => (run.order || run.places).length;

// ── 백그라운드 버전 확인 ─────────────────────────────────────────────
async function checkBackground() {
  const mv = chrome.runtime.getManifest().version;
  let bg = null;
  try {
    bg = (await chrome.runtime.sendMessage({ type: "ping" }))?.version;
  } catch {}
  $("ver").textContent = `v${mv}` + (bg && bg !== mv ? ` · 백그라운드 v${bg}` : bg ? "" : " · 백그라운드 응답 없음");
  if (mv !== EXPECTED || bg !== EXPECTED) {
    hint("확장이 최신 상태로 로드되지 않았습니다. " + RELOAD_MSG, true);
    return false;
  }
  return true;
}

function hint(text, err = false) {
  $("loadHint").textContent = text || "";
  $("loadHint").className = "hint" + (err ? " err" : "");
}

function showFolder(info) {
  if (!info) return $("folder").classList.remove("show");
  $("folderName").textContent = info.title || "(이름 없는 목록)";
  $("folderCount").textContent = `장소 ${info.count}개`;
  $("folder").classList.add("show");
}

// ── 불러오기 ────────────────────────────────────────────────────────
$("load").onclick = async () => {
  const link = $("link").value.trim();
  if (!link) return hint("네이버 지도에서 '공유'로 복사한 링크를 붙여 넣으세요.", true);
  if (!(await checkBackground())) return;
  $("load").disabled = true;
  hint("불러오는 중…");
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: "load", link });
  } catch (e) {
    r = { ok: false, error: "백그라운드 통신 실패: " + e.message };
  }
  $("load").disabled = false;
  if (!r?.ok) {
    places = [];
    showFolder(null);
    return hint("불러오지 못했습니다. " + (r?.error || RELOAD_MSG), true);
  }
  places = r.places;
  const info = { title: r.title, count: places.length, link };
  showFolder(info);
  hint(r.skipped ? `주소만 저장된 ${r.skipped}개는 장소가 아니라서 제외했습니다.` : "");
  chrome.storage.local.set({ loaded: { ...info, places } });
  updateStartButton();
};
$("link").addEventListener("keydown", (e) => e.key === "Enter" && $("load").click());

// ── 시작·이어서·중지 ────────────────────────────────────────────────
$("start").onclick = () => {
  const listName = $("list").value.trim();
  if (!places.length) return hint("먼저 네이버 링크를 불러오세요.", true);
  if (!listName) return $("list").focus();
  chrome.storage.local.set({ lastList: listName });
  chrome.runtime.sendMessage({ type: "start", places, listName });
};
$("resume").onclick = () => chrome.runtime.sendMessage({ type: "resume" });
$("retry").onclick = () => chrome.runtime.sendMessage({ type: "retryFailed" });
$("stop").onclick = () => chrome.runtime.sendMessage({ type: "stop" });
$("list").addEventListener("input", updateStartButton);

function updateStartButton() {
  const running = lastRun?.state === "running";
  // 멈춘 작업이 남아 있으면 '이어서'가 주 버튼이고, 시작 버튼은 보조(처음부터 다시)로 낮춘다.
  const unfinished =
    ((lastRun?.state === "halted" || lastRun?.state === "stopped") && lastRun.index < runTotal(lastRun)) ||
    // 실패 재시도 버튼이 떠 있을 때도 시작 버튼은 보조로 낮춘다.
    (lastRun && !running && (lastRun.log || []).some((e) => !isOk(e.status) && !isSkip(e.status)));
  $("start").style.display = running ? "none" : "";
  $("start").disabled = !places.length || !$("list").value.trim();
  const finished = lastRun?.state === "done";
  $("start").className = unfinished ? "ghost" : "primary";
  $("start").style.width = "100%";
  // 한 목록을 끝낸 뒤에는 새 목록을 옮기는 '다음 작업'으로 안내한다.
  $("start").textContent = finished ? "다음 작업 시작하기" : unfinished ? "처음부터 다시 시작" : "저장 시작";
}

// ── 결과 탭 ─────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    filter = t.dataset.f;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
    renderLog(lastRun);
  }),
);

// ── 화면 그리기 ─────────────────────────────────────────────────────
function render(run) {
  lastRun = run;
  updateStartButton();
  if (!run?.places) {
    $("progressCard").classList.remove("show");
    $("resultsCard").classList.remove("show");
    return;
  }
  const total = runTotal(run);
  const log = run.log || [];
  const nOk = log.filter((e) => isOk(e.status)).length;
  const nSkip = log.filter((e) => isSkip(e.status)).length;
  const nBad = log.length - nOk - nSkip;

  const stateKo = { running: "저장 중", done: "완료", stopped: "중지됨", halted: "멈춤" }[run.state] || run.state;
  $("state").textContent = `${run.round ? "실패 재시도 · " : ""}${stateKo} · ${run.listName}`;
  let eta = "";
  if (run.state === "running" && run.startedAt && run.index > (run.startIndex || 0)) {
    const per = (Date.now() - run.startedAt) / (run.index - (run.startIndex || 0));
    eta = ` · 약 ${Math.max(1, Math.ceil((per * (total - run.index)) / 60000))}분 남음`;
  }
  $("count").textContent = `${run.index} / ${total}${eta}`;
  $("barFill").style.width = `${total ? (run.index / total) * 100 : 0}%`;
  $("nOk").textContent = nOk;
  $("nSkip").textContent = nSkip;
  $("nBad").textContent = nBad;

  const banner = $("banner");
  banner.className = "banner";
  if (run.state === "halted") {
    banner.textContent = HALT_HELP[run.haltReason] || STATUS_KO[run.haltReason] || run.haltReason;
    if (run.haltReason === "LIST_NOT_FOUND" && run.haltLists?.length) {
      banner.textContent += ` 구글지도에 있는 목록: ${run.haltLists.join(", ")}`;
    }
    banner.classList.add("show", "red");
  } else if (run.state === "done") {
    banner.textContent = nBad
      ? `모두 처리했습니다. 실패 ${nBad}개는 '실패한 것만 다시 시도'로 한 번 더 해 보거나, 아래 '실패만'에서 확인하세요.`
      : "모든 장소를 구글지도 목록에 저장했습니다.";
    banner.classList.add("show", "green");
  }
  const canResume = (run.state === "halted" || run.state === "stopped") && run.index < total;
  const canRetry = run.state !== "running" && !canResume && nBad > 0;
  $("resume").style.display = canResume ? "" : "none";
  $("retry").style.display = canRetry ? "" : "none";
  $("retry").textContent = `실패한 ${nBad}개 다시 시도`;
  $("stop").style.display = run.state === "running" ? "" : "none";
  document.querySelector(".actions").style.display =
    canResume || canRetry || run.state === "running" ? "" : "none";

  $("progressCard").classList.add("show");
  renderLog(run);
}

function renderLog(run) {
  const log = run?.log || [];
  $("resultsCard").classList.toggle("show", log.length > 0);
  const rows = [...log].reverse().filter((e) => filter === "all" || !(isOk(e.status) || isSkip(e.status)));
  $("log").innerHTML = "";
  if (!rows.length) {
    $("log").innerHTML = `<div class="empty">${filter === "bad" ? "실패한 장소가 없습니다." : "아직 결과가 없습니다."}</div>`;
    return;
  }
  for (const e of rows) {
    const kind = isOk(e.status) ? "ok" : isSkip(e.status) ? "skip" : "bad";
    const row = document.createElement("div");
    row.className = "row";
    const dot = document.createElement("span");
    dot.className = "dot " + kind;
    const body = document.createElement("div");
    body.style.minWidth = "0";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = e.title && e.title !== e.name ? `${e.name} → ${e.title}` : e.name;
    const m = document.createElement("div");
    m.className = "m" + (kind === "bad" ? " bad" : "");
    let meta = STATUS_KO[e.status] || e.status;
    if (kind !== "bad" && e.dist != null) {
      meta += e.method?.endsWith("nearest")
        ? ` · 결과 ${e.candidates}개 중 선택 (${e.dist}m${e.closedSkipped ? `, 폐업·휴업 ${e.closedSkipped}곳 제외` : ""})`
        : ` · 네이버 위치와 ${e.dist}m`;
    }
    if (kind !== "bad" && e.closed) {
      meta += e.closed === "perm" ? " · ⚠ 구글에 폐업으로 표시됨" : " · ⚠ 임시 휴업 중";
    }
    if (e.lists) meta += ` · 있는 목록: ${e.lists.join(", ")}`;
    m.textContent = meta;
    if (kind !== "bad" && e.closed) m.className = "m warn";
    body.append(t, m);
    row.append(dot, body);
    row.title = "클릭하면 구글지도에서 열기";
    row.onclick = () => e.url && chrome.tabs.create({ url: e.url });
    $("log").appendChild(row);
  }
}

// ── 초기화 ──────────────────────────────────────────────────────────
(async () => {
  const { run, loaded, lastList } = await chrome.storage.local.get(["run", "loaded", "lastList"]);
  if (loaded) {
    places = loaded.places || [];
    $("link").value = loaded.link || "";
    showFolder(loaded);
  }
  if (lastList) $("list").value = lastList;
  render(run);
  checkBackground();
})();
chrome.storage.onChanged.addListener((c) => c.run && render(c.run.newValue));
// 남은 시간 표시를 갱신
setInterval(() => lastRun?.state === "running" && render(lastRun), 5000);
