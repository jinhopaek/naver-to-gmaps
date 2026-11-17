// 좌표와 후보 판정에 쓰는 순수 함수 모음. chrome API를 쓰지 않는다.
// 서비스 워커는 importScripts("geo.js")로 불러 전역 함수로 쓰고,
// 테스트(node --test)는 아래 module.exports로 불러 쓴다.

// 좌표 판정 기준(m)
const NEAREST_MAX = 250; // 검색 결과 여러 개 중 고를 때: 네이버 좌표에서 이 거리 안이어야 함
const DIRECT_MAX = 1000; // 바로 장소 페이지가 열렸을 때: 이보다 멀면 다른 장소로 보고 재검색

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

// 후보 점수(작을수록 좋음): 네이버 좌표와의 거리(m)
//  - 이름이 비슷하면 −100m (같은 건물에 가게가 여럿일 때 대비)
//  - 임시 휴업이면 +150m, 폐업이면 +1000m (근처에 영업 중인 곳이 있으면 항상 그쪽을 고름)
const CLOSED_PENALTY = { temp: 150, perm: 1000 };
const score = (r) => r.d - (r.nm ? 100 : 0) + (CLOSED_PENALTY[r.closed] || 0);

// 검색 결과 목록에서 네이버 좌표 기준 max(m) 안의 후보만 남기고 점수순으로 정렬한다.
// results: [{ href, label, closed }]  →  [{ ...r, d, nm }] (점수가 낮은 순)
function rankCandidates(p, results, max = NEAREST_MAX) {
  return results
    .map((r) => ({ ...r, d: distM(p, decodePlus(plusFromUrl(r.href))), nm: nameMatch(p.name, r.label) }))
    .filter((r) => r.d != null && r.d <= max)
    .sort((x, y) => score(x) - score(y));
}

if (typeof module !== "undefined") {
  module.exports = {
    NEAREST_MAX, DIRECT_MAX, CLOSED_PENALTY,
    decodePlus, plusFromUrl, distM, norm, nameMatch, score, rankCandidates,
  };
}
