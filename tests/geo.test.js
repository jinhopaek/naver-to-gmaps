// geo.js 단위 테스트. 실행: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const geo = require(path.join(__dirname, "..", "extension", "geo.js"));

// 테스트용 플러스 코드 인코더(10자리). 위경도 → 코드.
function encode(lat, lng) {
  const A = "23456789CFGHJMPQRVWX";
  let la = lat + 90, ln = lng + 180, res = 20, out = "";
  for (let i = 0; i < 5; i++) {
    const a = Math.floor(la / res), b = Math.floor(ln / res);
    out += A[a] + A[b];
    la -= a * res;
    ln -= b * res;
    res /= 20;
  }
  return out.slice(0, 8) + "+" + out.slice(8);
}
// 구글지도 장소 URL 형태로 감싼다(플러스 코드는 !20s 뒤에 URL 인코딩돼 들어 있다).
const placeUrl = (name, lat, lng) =>
  `https://www.google.com/maps/place/${encodeURIComponent(name)}/data=!4m7!3m6!1s0x0:0x0!8m2!3d${lat}!4d${lng}!16s%2Fg%2F1!20s${encodeURIComponent(encode(lat, lng))}`;

// 위도 1도 ≈ 111,195m 를 이용해 북쪽/동쪽으로 d미터 떨어진 점
const north = (p, m) => ({ lat: p.lat + m / 111195, lng: p.lng });
const east = (p, m) => ({ lat: p.lat, lng: p.lng + m / (111195 * Math.cos((p.lat * Math.PI) / 180)) });

test("decodePlus: Open Location Code 공식 테스트 벡터의 셀 중심을 돌려준다", () => {
  // github.com/google/open-location-code test_data/decoding.csv
  // 코드, 남쪽 위도, 서쪽 경도, 북쪽 위도, 동쪽 경도
  const vectors = [
    ["7FG49QCJ+2V", 20.37, 2.782125, 20.370125, 2.78225],
    ["7FG49QCJ+2VX", 20.3701, 2.78221875, 20.370125, 2.78225],
    ["7FG49QCJ+2VXGJ", 20.370113, 2.782234375, 20.370114, 2.78223632813],
    ["8FVC2222+22", 47.0, 8.0, 47.000125, 8.000125],
    ["4VCPPQGP+Q9", -41.273125, 174.785875, -41.273, 174.786],
    ["22222222+22", -90.0, -180.0, -89.999875, -179.999875],
    ["6FH32222+222", 1, 1, 1.000025, 1.00003125],
    ["CFX3X2X2+X2", 89.999875, 1, 90, 1.000125],
    ["849VGJQF+VX7QR3J", 37.53966912, -122.3750698242, 37.53966916, -122.3750697021],
    ["55CJG366+PP", -21.48825, -107.93825, -21.488125, -107.938125],
    ["4MC8JQQF+GG", -41.36125, 86.77375, -41.361125, 86.773875],
    ["85F6GC93+RFFVC35", 39.519572, -115.596335083008, 39.51957204, -115.596334960937],
  ];
  for (const [code, latLo, lngLo, latHi, lngHi] of vectors) {
    const c = geo.decodePlus(code);
    assert.ok(c, `${code} 를 해석하지 못함`);
    assert.ok(Math.abs(c.lat - (latLo + latHi) / 2) < 1e-6, `${code} 위도 ${c.lat}`);
    assert.ok(Math.abs(c.lng - (lngLo + lngHi) / 2) < 1e-6, `${code} 경도 ${c.lng}`);
  }
});

test("decodePlus: 짧은 코드나 잘못된 문자는 null", () => {
  assert.equal(geo.decodePlus("7FG49Q00+"), null); // 8자리 미만(지역 단위 코드)
  assert.equal(geo.decodePlus("8Q99H2A6+FHJ"), null); // A는 플러스 코드 문자가 아님
  assert.equal(geo.decodePlus(""), null);
});

test("plusFromUrl: 구글지도 URL에서 플러스 코드를 꺼낸다", () => {
  assert.equal(
    geo.plusFromUrl("https://www.google.com/maps/place/X/data=!4m7!3m6!1s0x0!8m2!3d0!4d0!16s%2Fg%2F1!20s8Q99H276%2BFHJ?hl=en"),
    "8Q99H276+FHJ",
  );
  assert.equal(geo.plusFromUrl("https://www.google.com/maps/search/cafe"), null);
  assert.equal(geo.plusFromUrl(undefined), null);
});

test("distM: 하버사인 거리(m)", () => {
  const p = { lat: 37.56, lng: 126.99 };
  assert.equal(geo.distM(p, p), 0);
  assert.equal(geo.distM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 111195); // 위도 1도
  assert.equal(geo.distM(p, north(p, 250)), 250);
  assert.equal(geo.distM(p, east(p, 77)), 77);
  const q = { lat: 37.5, lng: 127.03 };
  assert.equal(geo.distM(p, q), geo.distM(q, p)); // 대칭
  assert.equal(geo.distM(p, null), null);
  assert.equal(geo.distM(p, { lat: null, lng: 1 }), null);
});

test("nameMatch: 공백·기호를 지우고 한쪽이 다른 쪽을 포함하면 같은 이름으로 본다", () => {
  assert.equal(geo.nameMatch("테스트카페", "테스트 카페 2호점"), true);
  assert.equal(geo.nameMatch("KKOTT", "kkott"), true);
  assert.equal(geo.nameMatch("돈대카페 아웃포스트", "Outpost Cafe"), false); // 한글·영문 표기 차이는 못 잡는다
  assert.equal(geo.nameMatch("", "카페"), false);
});

test("score: 거리에 폐업 +1000, 임시 휴업 +150, 이름 비슷하면 −100", () => {
  assert.equal(geo.score({ d: 20, closed: "perm" }), 1020);
  assert.equal(geo.score({ d: 77, closed: null }), 77);
  assert.equal(geo.score({ d: 140, closed: "temp" }), 290);
  assert.equal(geo.score({ d: 120, nm: true }), 20);
});

test("rankCandidates: 폐업한 가장 가까운 곳보다 영업 중인 곳을 먼저 고르고, 반경 밖은 뺀다", () => {
  const P = { name: "테스트카페", lat: 37.56, lng: 126.99 };
  const at = (pt) => [pt.lat, pt.lng];
  const results = [
    { label: "A", closed: "perm", href: placeUrl("A", ...at(north(P, 20))) },
    { label: "B", closed: null, href: placeUrl("B", ...at(north(P, -77))) },
    { label: "C", closed: "temp", href: placeUrl("C", ...at(east(P, 140))) },
    { label: "D", closed: null, href: placeUrl("D", ...at(north(P, 410))) },
    { label: "E", closed: null, href: "https://www.google.com/maps/place/E" }, // 좌표 없음
  ];
  const ranked = geo.rankCandidates(P, results);
  assert.deepEqual(ranked.map((r) => r.label), ["B", "C", "A"]);
  // 10자리 플러스 코드 셀(약 14m) 안의 오차만 허용
  assert.ok(Math.abs(ranked[0].d - 77) <= 15, `B 거리 ${ranked[0].d}`);
});

test("rankCandidates: 이름이 같은 가게는 100m 가산점을 받는다", () => {
  const P = { name: "스타벅스 신당역점", lat: 37.566, lng: 127.017 };
  const results = [
    { label: "다른 카페", closed: null, href: placeUrl("X", P.lat + 60 / 111195, P.lng) },
    { label: "스타벅스 신당역점", closed: null, href: placeUrl("Y", P.lat - 120 / 111195, P.lng) },
  ];
  assert.deepEqual(geo.rankCandidates(P, results).map((r) => r.label), ["스타벅스 신당역점", "다른 카페"]);
});
