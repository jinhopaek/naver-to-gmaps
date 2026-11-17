#!/usr/bin/env python3
"""네이버 지도 공유 목록 → 구글 마이맵 가져오기용 KML/CSV 변환기.

사용법:  python3 naver2mymaps.py https://naver.me/XXXXXXX
결과:    <폴더이름>.kml, <폴더이름>.csv  (현재 폴더에 저장)

주의: 네이버 비공식 내부 엔드포인트를 사용한다. 구조가 바뀌면 깨질 수 있다.
"""
import csv
import json
import re
import sys
import urllib.request
from xml.sax.saxutils import escape

UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://map.naver.com/"}
API = ("https://pages.map.naver.com/save-pages/api/maps-bookmark/v3/shares/"
       "{sid}/bookmarks?start=0&limit=5000&sort=lastUseTime")


def resolve_share_id(link: str) -> str:
    m = re.search(r"folder/([0-9a-f]{32})", link)
    if not m:  # naver.me 단축 링크 → 리다이렉트 따라가기
        req = urllib.request.Request(link, headers=UA)
        with urllib.request.urlopen(req) as r:
            m = re.search(r"folder/([0-9a-f]{32})", r.geturl())
    if not m:
        sys.exit("공유 폴더 ID를 찾지 못했습니다. 네이버 지도 '저장 목록 공유' 링크인지 확인하세요.")
    return m.group(1)


def fetch(share_id: str) -> dict:
    req = urllib.request.Request(API.format(sid=share_id), headers=UA)
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def place_url(b: dict) -> str:
    if b.get("sid"):
        return f"https://map.naver.com/p/entry/place/{b['sid']}"
    return ""


def safe_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return name or "naver_list"


def to_kml(title: str, items: list) -> str:
    marks = []
    for b in items:
        desc = "<br>".join(x for x in [
            b.get("mcidName") or "",
            b.get("address") or "",
            b.get("memo") or "",
            place_url(b),
        ] if x)
        marks.append(
            "<Placemark>"
            f"<name>{escape(b.get('displayName') or b['name'])}</name>"
            f"<description><![CDATA[{desc}]]></description>"
            f"<Point><coordinates>{b['px']},{b['py']},0</coordinates></Point>"
            "</Placemark>"
        )
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            f"<name>{escape(title)}</name>" + "".join(marks) +
            "</Document></kml>\n")


def to_csv(path: str, items: list) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["name", "latitude", "longitude", "category", "address", "memo", "naver_url"])
        for b in items:
            w.writerow([b.get("displayName") or b["name"], b["py"], b["px"],
                        b.get("mcidName") or "", b.get("address") or "",
                        b.get("memo") or "", place_url(b)])


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    data = fetch(resolve_share_id(sys.argv[1]))
    folder = data.get("folder") or {}
    items = [b for b in data.get("bookmarkList", []) if b.get("px") and b.get("py")]
    title = folder.get("name") or "naver_list"
    base = safe_filename(title)

    with open(f"{base}.kml", "w", encoding="utf-8") as f:
        f.write(to_kml(title, items))
    to_csv(f"{base}.csv", items)

    total = folder.get("bookmarkCount")
    print(f"'{title}': {len(items)}개 변환 (네이버 표기 {total}개) → {base}.kml, {base}.csv")
    if total and total != len(items):
        print("※ 개수가 다릅니다. 좌표 없는 항목이 있거나 일부만 내려왔을 수 있습니다.")


if __name__ == "__main__":
    main()
