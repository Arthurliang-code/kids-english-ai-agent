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
JUNK = re.compile(
    r"家伙|复数|分词|过去式|赌博|分队|部队|帐簿|名册|工作簿|神父|玩笑|游玩|跳动|假装|开玩笑|传摇曳|演戏|扮演|\.\.\.|…|^当.+的"
)
BAD_EN = re.compile(
    r"drama|theatrical|priest|church|trinity|\bgod\b|military|legal|medicine|vulgar|slang|computer|sexual|obsolete|baseball|binary compound|empedocles|mentally and emotionally|playing cards|card game|preset plan|feasible|organization regarded|eurasian|widely cultivated|distinguished position",
    re.I,
)
NICE_EN = re.compile(
    r"\b(game|child|school|friend|family|fruit|water|book|home|play|happy|mother|father|together|run|read|like|parent|pages|company|liquid|joy|pleasure|foot)\b",
    re.I,
)
KEEP_TAGS = {"zk", "gk", "cet4", "cet6", "ky", "ielts", "toefl", "gre"}
FORM_TYPES = {"p", "d", "i", "3", "s", "r", "t"}


def usable_lines(text: str) -> list[str]:
    return [
        line.strip()
        for line in text.replace("\\n", "\n").split("\n")
        if line.strip() and not any(mark in line for mark in SKIP)
    ]


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


def too_close(picked: list[str], gloss: str) -> bool:
    for old in picked:
        if gloss.startswith(old) or old.startswith(gloss):
            return True
    return False


def glosses(line: str) -> list[str]:
    out: list[str] = []
    for item in pieces(line):
        if len(item) > 18 or JUNK.search(item) or too_close(out, item):
            continue
        out.append(item)
    return out


def kid_meaning(translation: str) -> str:
    picked: list[str] = []
    for index, line in enumerate(usable_lines(translation)[:3]):
        raw = next(iter(pieces(line)), None)
        if raw and JUNK.search(raw):
            continue
        cap = 3 if index == 0 else 2
        for gloss in glosses(line)[:cap]:
            if too_close(picked, gloss):
                continue
            picked.append(gloss)
            if len(picked) >= 4:
                return "；".join(picked)
    return "；".join(picked)


def shorten(text: str, max_len: int = 72) -> str:
    if len(text) <= max_len:
        return text
    slice_ = text[:max_len]
    cut = max(slice_.rfind(","), slice_.rfind(" "))
    return (slice_[:cut] if cut > 30 else slice_).strip()


def to_sentence(word: str, raw: str) -> str | None:
    text = shorten(POS.sub("", raw))
    text = re.sub(r"\[[^\]]*\]", "", text).replace("。", "").replace("．", "").strip()
    if not text or len(text) < 8 or not re.search(r"[A-Za-z]", text):
        return None
    display = word[:1].upper() + word[1:]
    if re.match(r"^(a|an|the)\s", text, re.I):
        return f"{display} is {text}."
    if re.match(r"^to\s", text, re.I):
        rest = text[3:]
        if not rest or re.match(r"^be\s", rest, re.I):
            return f"{display} means {text}."
        return f"I {rest}."
    return f"{display} means {text}."


def score_english(text: str) -> float:
    score = 50 - abs(len(text) - 48) / 2
    if BAD_EN.search(text):
        score -= 60
    if NICE_EN.search(text):
        score += 18
    stripped = POS.sub("", text)
    if re.match(r"^(a|an|the|to)\s", stripped, re.I):
        score += 8
    if len(text) > 90:
        score -= 12
    return score


def kid_example(word: str, definition: str) -> str:
    ranked = sorted(
        ((line, score_english(line)) for line in usable_lines(definition)),
        key=lambda item: item[1],
        reverse=True,
    )
    out: list[str] = []
    for line, score in ranked:
        if score < 0:
            continue
        sentence = to_sentence(word, line)
        if not sentence or sentence in out:
            continue
        out.append(sentence)
        if len(out) == 2:
            break
    return "\n".join(out)


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
            example = kid_example(key, row.get("definition") or "")
            if key not in entries:
                entries[key] = [phonetic, meaning, example] if example else [phonetic, meaning]
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
