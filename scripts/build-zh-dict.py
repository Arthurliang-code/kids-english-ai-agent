#!/usr/bin/env python3
"""Build a compact kid-facing EN-ZH dictionary from ECDICT."""

from __future__ import annotations

import csv
import gzip
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "scripts" / ".cache"
OUT = ROOT / "apps" / "web" / "public" / "lexicon" / "zh-senses.json.gz"
SOURCE = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
LEMMA_SOURCE = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/lemma.en.txt"
WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'-]{0,22}$")
POS = re.compile(r"^[a-zA-Z]{1,8}\.\s*")
SKIP = ("[网络]", "[计算机]", "[医]", "[化学]", "[药]", "[法律]", "[金融]", "[俚语]", "[计]", "[口]", "[俚]")
JUNK = re.compile(r"家伙|复数|分词|过去式|\.\.\.|…|^当.+的")
KEEP_TAGS = {"zk", "gk", "cet4", "cet6", "ky", "ielts", "toefl", "gre"}
FORM_TYPES = {"p", "d", "i", "3", "s", "r", "t"}


def kid_meaning(translation: str) -> str:
    lines = [
        line.strip()
        for line in translation.replace("\\n", "\n").split("\n")
        if line.strip() and not any(mark in line for mark in SKIP)
    ]
    picked: list[str] = []

    def pieces(line: str) -> list[str]:
        text = POS.sub("", line)
        text = re.sub(r"\[[^\]]*\]", "", text)
        out: list[str] = []
        for chunk in re.split(r"[；;]", text):
            for piece in re.split(r"[，,]", chunk):
                gloss = re.sub(r"[。．、\s]+", " ", piece).strip()
                if gloss and re.search(r"[\u4e00-\u9fff]", gloss):
                    out.append(gloss)
        return out

    def glosses(line: str) -> list[str]:
        out: list[str] = []
        for gloss in pieces(line):
            if len(gloss) > 18 or JUNK.search(gloss):
                continue
            if any(gloss.startswith(item) or item.startswith(gloss) for item in out):
                continue
            out.append(gloss)
        return out

    limit = 1 if len(lines) == 1 else 2
    for line in lines[:limit]:
        raw = next(iter(pieces(line)), None)
        if raw and JUNK.search(raw):
            continue
        first = next(iter(glosses(line)), None)
        if not first or first in picked:
            continue
        if picked and first.endswith("的") and not picked[0].endswith("的"):
            continue
        picked.append(first)
    return "；".join(picked)


def keep_row(oxford: str, collins: str, tag: str, bnc: str, frq: str) -> bool:
    if oxford.strip() == "1":
        return True
    if collins.isdigit() and int(collins) >= 1:
        return True
    tags = set(tag.lower().split())
    if tags & KEEP_TAGS:
        return True
    for raw in (frq, bnc):
        if raw.isdigit() and 0 < int(raw) <= 30000:
            return True
    return False


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 10_000:
        return
    print(f"downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "kids-english-ai-agent/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        dest.write_bytes(response.read())


def parse_lemmas(text: str) -> dict[str, str]:
    forms: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(";") or "->" not in line:
            continue
        left, right = line.split("->", 1)
        lemma = left.strip().lower()
        if not WORD_RE.match(lemma):
            continue
        for form in right.split(","):
            item = form.strip().lower()
            if item and item != lemma and WORD_RE.match(item):
                forms.setdefault(item, lemma)
    return forms


def main() -> None:
    csv_path = CACHE / "ecdict.csv"
    lemma_path = CACHE / "lemma.en.txt"
    download(SOURCE, csv_path)
    try:
        download(LEMMA_SOURCE, lemma_path)
        lemma_forms = parse_lemmas(lemma_path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        lemma_forms = {}

    entries: dict[str, list[str]] = {}
    exchange_forms: dict[str, str] = {}
    csv.field_size_limit(10 * 1024 * 1024)
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            word = (row.get("word") or "").strip()
            if not WORD_RE.match(word) or " " in word:
                continue
            key = word.lower()
            if not keep_row(
                row.get("oxford") or "",
                row.get("collins") or "",
                row.get("tag") or "",
                row.get("bnc") or "",
                row.get("frq") or "",
            ):
                continue
            exchange = row.get("exchange") or ""
            lemma = ""
            for item in exchange.split("/"):
                if item.startswith("0:"):
                    lemma = item[2:].strip().lower()
            if lemma and lemma != key:
                if WORD_RE.match(lemma):
                    exchange_forms.setdefault(key, lemma)
                continue
            meaning = kid_meaning(row.get("translation") or "")
            if not meaning:
                continue
            phonetic = (row.get("phonetic") or "").strip()
            if key not in entries:
                entries[key] = [phonetic, meaning]
            for item in exchange.split("/"):
                if ":" not in item:
                    continue
                kind, form = item.split(":", 1)
                form = form.strip().lower()
                if kind in FORM_TYPES and form and form != key and WORD_RE.match(form):
                    exchange_forms.setdefault(form, key)

    payload: dict[str, str | list[str]] = dict(entries)
    for form, lemma in {**lemma_forms, **exchange_forms}.items():
        if form in payload:
            continue
        if lemma in entries:
            payload[form] = lemma

    OUT.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(OUT, "wb", compresslevel=9) as handle:
        handle.write(encoded)
    samples = ["apple", "play", "played", "together", "unit", "father", "books"]
    print(f"wrote {OUT} entries={len(entries)} forms={len(payload) - len(entries)} bytes={OUT.stat().st_size}")
    for word in samples:
        value = payload.get(word)
        if isinstance(value, str):
            value = payload.get(value)
        print(f"  {word}: {value}")


if __name__ == "__main__":
    main()
