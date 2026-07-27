#!/usr/bin/env python3
"""
News Intelligence Dashboard — backend.

A dependency-free (Python 3.9 stdlib only) server that:
  * polls ~50 real, free public RSS feeds in a background thread,
  * also builds Google News RSS queries on demand for search / long-tail
    categories / countries / local news,
  * parses RSS + Atom, strips HTML, builds extractive multi-length summaries,
  * clusters articles that report the same event (cross-source comparison),
  * computes trending keywords with growth, an importance score, an interactive
    map breakdown, and an extractive "Ask the news" retrieval answer — all cited.

No data is ever fabricated. Every article links back to its real source, and
every "Ask" answer quotes real headlines with attributions.

Run:  python3 server.py   then open  http://localhost:8770
"""

import base64
import hashlib
import hmac
import html
import html.entities
import json
import math
import os
import re
import ssl
import threading
from concurrent.futures import ThreadPoolExecutor
import time
import urllib.parse
import urllib.request
import gzip
import io
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree as ET

import feeds as F
import push as webpush

PORT = int(os.environ.get("PORT") or os.environ.get("NEWS_PORT") or "8770")
HOST = os.environ.get("HOST", "127.0.0.1")   # set HOST=0.0.0.0 when hosting online
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CONFIG_FILE = os.path.join(HERE, "config.json")
ENV_FILE = os.path.join(HERE, ".env")
# Writable state (users, photos, push subs, vapid key) lives under DATA_DIR so it can
# point at a persistent volume in the cloud; defaults to the code dir for local/Mac use.
DATA_DIR = os.environ.get("DATA_DIR") or HERE
os.makedirs(DATA_DIR, exist_ok=True)


def load_env():
    """Load KEY=VALUE pairs from .env into os.environ (without clobbering real env)."""
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except Exception:
        pass


load_env()


def get_config():
    """Runtime config (e.g. Google OAuth client id). Priority: .env / env var, then config.json."""
    cfg = {}
    try:
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
    except Exception:
        pass
    env_cid = os.environ.get("GOOGLE_CLIENT_ID")
    if env_cid:
        cfg["google_client_id"] = env_cid
    cfg.setdefault("google_client_id", "")
    return cfg
REFRESH_SECONDS = 600          # background refresh cadence
FETCH_TIMEOUT = 12
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) NewsIntel/1.0"

_SSL = ssl.create_default_context()
_SSL.check_hostname = False
_SSL.verify_mode = ssl.CERT_NONE

STOPWORDS = set("""
a an the and or but of to in on for with from by at as is are was were be been being
this that these those it its he she they them his her their our your you we i my me
has have had do does did will would can could should may might must not no yes new
say says said after before over under into out up down off about more most than then
us uk new latest news say report reports amid against ahead set get gets got make made
will not has been over two one three first second new year years day days week month
what who whom whose why how when where which need know today guide major follow
welcome newsletter latest update updates live full read watch video amid via per
january february march april june july august september october november december
monday tuesday wednesday thursday friday saturday sunday
happening happen happens uk eu mr mrs ms vs am pm st nd rd th ago says
""".split())

# 2-char tokens are dropped unless they are meaningful acronyms/tickers.
SHORT_KEEP = {"ai", "ev", "f1", "5g", "6g", "ml", "vr", "ar", "un", "g7", "g20"}


# ---------------------------------------------------------------------------
# Networking + parsing helpers
# ---------------------------------------------------------------------------
MAX_FETCH_BYTES = 8 * 1024 * 1024   # cap raw + decompressed size (feeds are small; blocks bombs)


def fetch(url, timeout=FETCH_TIMEOUT):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Encoding": "gzip, deflate",
    })
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as r:
        raw = r.read(MAX_FETCH_BYTES + 1)                 # bounded read (memory-DoS guard)
        if len(raw) > MAX_FETCH_BYTES:
            raise ValueError("response too large")
        enc = (r.headers.get("Content-Encoding") or "").lower()
        if enc == "gzip":
            gz = gzip.GzipFile(fileobj=io.BytesIO(raw))
            raw = gz.read(MAX_FETCH_BYTES + 1)            # bounded decompress (zip-bomb guard)
            if len(raw) > MAX_FETCH_BYTES:
                raise ValueError("decompressed response too large")
        elif enc == "deflate":
            import zlib
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                raw = zlib.decompress(raw, -zlib.MAX_WBITS)
            if len(raw) > MAX_FETCH_BYTES:
                raise ValueError("decompressed response too large")
    return raw


TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def clean_text(s):
    if not s:
        return ""
    s = html.unescape(s)
    s = TAG_RE.sub(" ", s)
    s = html.unescape(s)
    return WS_RE.sub(" ", s).strip()


def first_img(s):
    if not s:
        return None
    m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', s)
    return m.group(1) if m else None


def localname(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def find_first(elem, *names):
    """Return text of the first matching child (namespace-insensitive)."""
    want = set(names)
    for child in elem.iter():
        if localname(child.tag) in want:
            txt = child.text or child.get("href") or ""
            if txt and txt.strip():
                return txt.strip()
    return ""


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except Exception:
            continue
    return None


SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")


def sentences(text):
    return [s.strip() for s in SENT_SPLIT.split(text) if len(s.strip()) > 2]


def brief_summary(text, title, max_words=60):
    """An Inshorts-style ~60-word brief: whole sentences, capped, self-contained."""
    sents = sentences(text or "")
    if not sents:
        return title
    out, n = [], 0
    for s in sents:
        w = len(s.split())
        if out and n + w > max_words:
            break
        out.append(s)
        n += w
        if n >= max_words - 6:
            break
    res = " ".join(out).strip()
    words = res.split()
    if len(words) > max_words:
        res = " ".join(words[:max_words]).rstrip(",.;:- ") + "…"
    return res or title


def summaries(text, title):
    """Build the multi-length summaries from real article text (extractive)."""
    text = text or ""
    sents = sentences(text)
    full = text
    if not sents:
        sents = [title]
    short = sents[0]
    two_min = " ".join(sents[:5]) if len(sents) > 1 else full
    bullets = sents[:6]
    # ELI5: simplest = shortest sentence, trimmed, plain-framed.
    eli5 = min(sents, key=len) if sents else title
    words = len(text.split())
    return {
        "brief": brief_summary(text, title),
        "thirty": short[:320],
        "twomin": two_min[:1200],
        "detailed": full[:4000],
        "bullets": bullets,
        "eli5": ("In simple terms: " + eli5)[:400],
        "word_count": words,
        "reading_time": max(1, round(words / 200)) if words else 1,
    }


TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9'+-]+")


# ---------------------------------------------------------------------------
# Article enrichment — when an RSS item ships only a headline (no body text),
# fetch the article page's own published description (og:description / meta
# description) so the brief is a real summary, not the title repeated.
# Cached by URL; persists across refreshes; never fabricates text.
# ---------------------------------------------------------------------------
ENRICH_CACHE = {}
ENRICH_LOCK = threading.Lock()

_META_RES = [
    re.compile(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:description["\']', re.I),
    re.compile(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'<meta[^>]+name=["\']twitter:description["\'][^>]+content=["\']([^"\']+)["\']', re.I),
]
_P_RE = re.compile(r"<p[^>]*>(.*?)</p>", re.I | re.S)
_NAV_MARKERS = ("skip to content", "accessibility help", "your account", "sign in",
                "subscribe", "homepage", "cookie", "newsletter", "follow us", "menu",
                "all rights reserved", "terms of", "privacy policy", "advertisement")
_FUNC_WORDS = (" the ", " a ", " to ", " of ", " in ", " was ", " is ", " said ",
               " has ", " and ", " on ", " for ", " that ", " with ", " after ")


def _looks_like_prose(t):
    """Reject navigation/boilerplate: real prose has function words and no nav markers."""
    low = " " + t.lower() + " "
    if any(m in low for m in _NAV_MARKERS):
        return False
    return sum(1 for w in _FUNC_WORDS if w in low) >= 2


def fetch_description(url):
    """Best-effort: pull the article's own description / lead paragraphs. Cached."""
    with ENRICH_LOCK:
        if url in ENRICH_CACHE:
            return ENRICH_CACHE[url]
    text = ""
    try:
        raw = fetch(url, timeout=6)[:400000]
        page = raw.decode("utf-8", "ignore")
        meta = ""
        for rgx in _META_RES:
            m = rgx.search(page)
            if m:
                cand = clean_text(html.unescape(m.group(1)))
                if len(cand.split()) >= 8 and _looks_like_prose(cand):
                    meta = cand
                    break
        # Build a fuller ~60-word summary: meta description + lead paragraphs,
        # skipping near-duplicates and navigation boilerplate.
        combined = meta
        if len(combined.split()) < 55:
            for p in _P_RE.findall(page):
                if len(combined.split()) >= 55:
                    break
                t = clean_text(p)
                if len(t.split()) < 10 or not _looks_like_prose(t):
                    continue
                if combined and t[:45].lower() in combined.lower():
                    continue
                combined = (combined + " " + t).strip() if combined else t
        text = combined
    except Exception:
        text = ""
    with ENRICH_LOCK:
        ENRICH_CACHE[url] = text
    return text


def _thin(story, min_words=16):
    """True when the story's brief is shorter than we'd like (or just the headline)."""
    brief = (story.get("summaries") or {}).get("brief", "")
    title = story.get("title", "")
    return len(brief.split()) < min_words or brief.strip().lower() == title.strip().lower()


def enrich_story(story, min_words=16):
    if not _thin(story, min_words) or not story.get("link"):
        return story
    desc = fetch_description(story["link"])
    if desc and len(desc.split()) > len((story.get("summary") or "").split()):
        sm = summaries(desc, story["title"])
        story["summary"] = desc[:600]
        story["summaries"] = sm
        story["reading_time"] = sm["reading_time"]
    return story


def enrich_many(stories, cap=16, min_words=16):
    todo = [s for s in stories[:cap] if _thin(s, min_words)]
    if not todo:
        return stories
    with ThreadPoolExecutor(max_workers=10) as ex:
        list(ex.map(lambda s: enrich_story(s, min_words), todo))
    return stories


def tokens(text):
    out = []
    for w in TOKEN_RE.findall((text or "").lower()):
        if w in STOPWORDS:
            continue
        if len(w) < 3 and w not in SHORT_KEEP:
            continue
        out.append(w)
    return out


def sig_tokens(title):
    """Signature tokens for clustering: content words + capitalised entities."""
    toks = set(tokens(title))
    caps = {w.lower() for w in re.findall(r"\b[A-Z][a-zA-Z]{2,}\b", title or "")}
    return (toks | caps) - STOPWORDS


# ---------------------------------------------------------------------------
# Article model
# ---------------------------------------------------------------------------
def article_id(link, title):
    base = (link or "") + "|" + (title or "")
    h = 0
    for ch in base:
        h = (h * 131 + ord(ch)) & 0xFFFFFFFFFFFF
    return format(h, "x")


def pub_meta(name):
    return F.PUBLISHERS.get(name, F.UNKNOWN_PUBLISHER)


def make_article(title, link, desc, pubdate, author, publisher, category, scope, image):
    title = clean_text(title)
    desc_txt = clean_text(desc)
    if not title or not link:
        return None
    dt = parse_date(pubdate)
    meta = pub_meta(publisher)
    summ = summaries(desc_txt, title)
    return {
        "id": article_id(link, title),
        "title": title,
        "link": link.strip(),
        "summary": desc_txt[:600],
        "summaries": summ,
        "published": dt.isoformat() if dt else None,
        "published_ts": dt.timestamp() if dt else 0,
        "author": clean_text(author) or None,
        "publisher": publisher,
        "category": category,
        "scope": scope,
        "image": image or first_img(desc),
        "country": meta["country"],
        "bias": meta["bias"],
        "bias_pos": F.BIAS_POS.get(meta["bias"], 0),
        "reliability": meta["reliability"],
        "ownership": meta["ownership"],
        "reading_time": summ["reading_time"],
        "archive": "https://web.archive.org/web/" + (link.strip() if link else ""),
        "sig": sorted(sig_tokens(title)),
    }


_DOCTYPE_RE = re.compile(rb"<!DOCTYPE[^>\[]*(\[[^\]]*\])?[^>]*>", re.I | re.S)
_ENT_RE = re.compile(rb"&([a-zA-Z][a-zA-Z0-9]{1,31});")
_XML_SAFE_ENTS = {b"amp", b"lt", b"gt", b"quot", b"apos"}


def sanitize_xml(raw):
    """Make a raw feed safe + parseable for expat:
    - strip any DTD/DOCTYPE → blocks billion-laughs / entity-expansion DoS from a feed;
    - rewrite named HTML entities (&nbsp; &mdash; …) to numeric refs so a single such
      entity doesn't make expat reject — and silently drop — the whole feed.
    """
    if not isinstance(raw, (bytes, bytearray)):
        return raw
    raw = _DOCTYPE_RE.sub(b"", raw)

    def _repl(m):
        name = m.group(1)
        if name in _XML_SAFE_ENTS:
            return m.group(0)
        cp = html.entities.name2codepoint.get(name.decode("ascii"))
        return (b"&#" + str(cp).encode() + b";") if cp is not None else m.group(0)

    return _ENT_RE.sub(_repl, raw)


def parse_feed(raw, publisher, category, scope, gnews=False):
    out = []
    raw = sanitize_xml(raw)
    try:
        root = ET.fromstring(raw)
    except Exception:
        # Some feeds have leading junk; retry from first '<'
        try:
            idx = raw.find(b"<")
            root = ET.fromstring(raw[idx:])
        except Exception:
            return out
    items = [e for e in root.iter() if localname(e.tag) in ("item", "entry")]
    for it in items:
        title = find_first(it, "title")
        link = ""
        for ch in it:
            if localname(ch.tag) == "link":
                link = (ch.text or ch.get("href") or "").strip()
                if link:
                    break
        if not link:
            link = find_first(it, "guid", "id")
        desc = find_first(it, "description", "summary", "content", "encoded")
        date = find_first(it, "pubDate", "published", "updated", "date")
        author = find_first(it, "creator", "author", "name")
        pub = publisher
        img = None
        # media:content / media:thumbnail / enclosure
        for ch in it.iter():
            ln = localname(ch.tag)
            if ln in ("content", "thumbnail", "enclosure") and ch.get("url"):
                u = ch.get("url")
                if any(u.lower().endswith(x) for x in (".jpg", ".jpeg", ".png", ".webp")) or "image" in (ch.get("type") or ""):
                    img = u
                    break
        if gnews:
            # Google News: title is "Headline - Publisher"; <source> has the outlet.
            src = it.find("{*}source")
            if src is not None and src.text:
                pub = src.text.strip()
            elif " - " in title:
                pub = title.rsplit(" - ", 1)[1].strip()
            if " - " in title and pub and title.endswith(pub):
                title = title[: -(len(pub) + 3)].strip()
        a = make_article(title, link, desc, date, author, pub, category, scope, img)
        if a:
            out.append(a)
    return out


# ---------------------------------------------------------------------------
# In-memory store + background refresh
# ---------------------------------------------------------------------------
class Store:
    def __init__(self):
        self.by_id = {}
        self.articles = []
        self.last_refresh = 0
        self.loading = True
        self.refreshing = False
        self.errors = []
        self.lock = threading.Lock()
        self.gn_cache = {}      # query-key -> (ts, articles)

    def refresh(self):
        if self.refreshing:
            return
        self.refreshing = True
        try:
            self._do_refresh()
        finally:
            self.refreshing = False

    def _do_refresh(self):
        new = {}
        errs = []

        def one(spec):
            url, publisher, category, scope = spec
            try:
                raw = fetch(url)
                return (parse_feed(raw, publisher, category, scope), None)
            except Exception as e:
                return ([], f"{publisher} ({category}): {type(e).__name__}")

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=12) as ex:
            for arts, err in ex.map(one, F.FEEDS):
                for a in arts:
                    new[a["id"]] = a
                if err:
                    errs.append(err)
        if not new:
            # keep previous data on a total failure
            self.errors = errs
            self.loading = False
            return
        arts = sorted(new.values(), key=lambda a: a["published_ts"], reverse=True)
        with self.lock:
            self.by_id = new
            self.articles = arts
            self.last_refresh = time.time()
            self.errors = errs
            self.loading = False

    def loop(self):
        while True:
            try:
                self.refresh()
            except Exception as e:
                self.errors = [f"refresh: {e}"]
            time.sleep(REFRESH_SECONDS)

    # --- Google News dynamic fetch (cached 8 min) -------------------------
    def google_news(self, query, india=False, category="World", ttl=480):
        key = f"{query}|{india}"
        now = time.time()
        hit = self.gn_cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
        if india:
            params = dict(hl="en-IN", gl="IN", ceid="IN:en")
        else:
            params = dict(hl="en-US", gl="US", ceid="US:en")
        url = "https://news.google.com/rss/search?q=" + urllib.parse.quote(query) + \
              "&" + urllib.parse.urlencode(params)
        try:
            raw = fetch(url)
            arts = parse_feed(raw, "Google News", category, "india" if india else "world", gnews=True)
        except Exception:
            arts = []
        # merge metadata for known publishers
        for a in arts:
            meta = pub_meta(a["publisher"])
            a.update(country=meta["country"], bias=meta["bias"],
                     bias_pos=F.BIAS_POS.get(meta["bias"], 0),
                     reliability=meta["reliability"], ownership=meta["ownership"])
        self.gn_cache[key] = (now, arts)
        return arts


STORE = Store()


# ---------------------------------------------------------------------------
# Clustering (cross-source comparison)
# ---------------------------------------------------------------------------
def cluster(articles, threshold=0.34):
    clusters = []
    inv = {}  # token -> list of cluster indices
    for a in articles:
        sig = set(a["sig"])
        if not sig:
            clusters.append({"items": [a], "sig": sig})
            continue
        candidates = set()
        for t in sig:
            candidates.update(inv.get(t, ()))
        best, best_score = -1, 0.0
        for ci in candidates:
            csig = clusters[ci]["sig"]
            inter = len(sig & csig)
            if not inter:
                continue
            score = inter / len(sig | csig)
            if score > best_score:
                best, best_score = ci, score
        if best >= 0 and best_score >= threshold:
            clusters[best]["items"].append(a)
            clusters[best]["sig"] |= sig
            for t in sig:
                inv.setdefault(t, []).append(best)
        else:
            ci = len(clusters)
            clusters.append({"items": [a], "sig": sig})
            for t in sig:
                inv.setdefault(t, []).append(ci)
    return clusters


def importance(cl):
    """0-100 importance from #publishers, source reliability, recency, urgency."""
    items = cl["items"]
    pubs = {i["publisher"] for i in items}
    rel = max((i["reliability"] for i in items), default=0)
    newest = max((i["published_ts"] for i in items), default=0)
    age_h = (time.time() - newest) / 3600 if newest else 72
    recency = max(0, 1 - age_h / 48)
    urgent = any(re.search(r"\b(breaking|killed|dead|attack|war|crash|earthquake|explosion|emergency|resign|ban|verdict|wins?|election)\b",
                           i["title"], re.I) for i in items)
    score = (min(len(pubs), 6) / 6) * 45 + (rel / 100) * 25 + recency * 20 + (10 if urgent else 0)
    return round(min(100, score))


def build_story(cl):
    items = sorted(cl["items"], key=lambda a: a["published_ts"], reverse=True)
    lead = max(items, key=lambda a: (a["reliability"], a["published_ts"]))
    pubs = []
    seen = set()
    for i in items:
        if i["publisher"] not in seen:
            seen.add(i["publisher"])
            pubs.append(i["publisher"])
    imp = importance(cl)
    # timeline = items by time
    timeline = [{"publisher": i["publisher"], "title": i["title"],
                 "published": i["published"], "link": i["link"]}
                for i in sorted(items, key=lambda a: a["published_ts"])]
    # bias spread
    biases = [i["bias_pos"] for i in items if i["bias"] != "n/a"]
    bias_spread = (max(biases) - min(biases)) if biases else 0
    out = dict(lead)
    out.update({
        "story_id": lead["id"],
        "num_publishers": len(pubs),
        "publishers": pubs,
        "importance": imp,
        "importance_band": "High" if imp >= 70 else ("Medium" if imp >= 45 else "Low"),
        "sources": [{"publisher": i["publisher"], "title": i["title"], "link": i["link"],
                     "published": i["published"], "reliability": i["reliability"],
                     "bias": i["bias"], "bias_pos": i["bias_pos"]} for i in items],
        "timeline": timeline,
        "bias_spread": bias_spread,
    })
    return out


# ---------------------------------------------------------------------------
# Trends
# ---------------------------------------------------------------------------
def trends(articles, limit=18):
    now = time.time()
    recent, older = {}, {}
    text_pool = []
    for a in articles:
        age = (now - a["published_ts"]) / 3600 if a["published_ts"] else 99
        toks = set(tokens(a["title"]))
        bigrams = set()
        words = tokens(a["title"])
        for i in range(len(words) - 1):
            bigrams.add(words[i] + " " + words[i + 1])
        feats = toks | bigrams
        bucket = recent if age <= 8 else older
        for f in feats:
            bucket[f] = bucket.get(f, 0) + 1
    out = []
    allf = set(recent) | set(older)
    for f in allf:
        r, o = recent.get(f, 0), older.get(f, 0)
        total = r + o
        if total < 3 or len(f) < 4:
            continue
        growth = (r - o) / max(1, o) if o else (r if r else 0)
        out.append({"term": f, "count": total, "recent": r,
                    "growth": round(growth, 2),
                    "hot": r >= 3 and r >= o})
    out.sort(key=lambda x: (x["recent"], x["count"]), reverse=True)
    return out[:limit]


# ---------------------------------------------------------------------------
# Ask the news (extractive retrieval, cited)
# ---------------------------------------------------------------------------
def ask(query, articles):
    q = set(tokens(query))
    if not q:
        return {"answer": "Please ask a question with some keywords.", "citations": []}
    scored = []
    for a in articles:
        hay = tokens(a["title"]) * 2 + tokens(a["summary"])
        if not hay:
            continue
        overlap = sum(1 for w in hay if w in q)
        if overlap:
            score = overlap / math.sqrt(len(hay)) + a["reliability"] / 200
            scored.append((score, a))
    scored.sort(key=lambda x: x[0], reverse=True)
    top = [a for _, a in scored[:6]]
    if not top:
        return {"answer": "I couldn't find anything in the current feed about that. "
                          "Try different keywords, or check back after the next refresh.",
                "citations": []}
    lines = []
    cites = []
    n = 0
    for a in top:
        s = [x for x in (sentences(a["summary"]) or []) if len(x) > 12] or [a["title"]]
        n += 1
        lines.append(f"{s[0]} [{n}]")
        cites.append({"n": n, "title": a["title"], "publisher": a["publisher"],
                      "link": a["link"], "published": a["published"],
                      "reliability": a["reliability"]})
    answer = "Based on the current feed:\n\n" + "\n\n".join("• " + l for l in lines)
    answer += "\n\n(Extractive summary built only from real headlines in the feed — every point is cited below.)"
    return {"answer": answer, "citations": cites}


# ---------------------------------------------------------------------------
# Query / filter pipeline
# ---------------------------------------------------------------------------
def within_time(a, since_hours):
    if not since_hours:
        return True
    if not a["published_ts"]:
        return True
    return (time.time() - a["published_ts"]) <= since_hours * 3600


def filter_articles(scope=None, category=None, country=None, publisher=None,
                    q=None, since_hours=None, min_reliability=0, bias=None,
                    state=None):
    qtok = set(tokens(q)) if q else None
    res = []
    with STORE.lock:
        pool = list(STORE.articles)
    for a in pool:
        if scope and a["scope"] != scope:
            continue
        if category and category != "World" and a["category"] != category:
            continue
        if country and a["country"] != country:
            continue
        if publisher and a["publisher"] != publisher:
            continue
        if bias and a["bias"] != bias:
            continue
        if a["reliability"] < min_reliability:
            continue
        if not within_time(a, since_hours):
            continue
        if state and state.lower() not in (a["title"] + " " + a["summary"]).lower():
            continue
        if qtok:
            hay = set(tokens(a["title"] + " " + a["summary"]))
            if not (qtok & hay):
                continue
        res.append(a)
    return res


# ---------------------------------------------------------------------------
# Visitor tracking — who is opening the dashboard and on what device.
# In-memory access log keyed by (ip + user-agent). No external calls, no auth.
# ---------------------------------------------------------------------------
VISITORS = {}
VIS_LOCK = threading.Lock()
IDENTITY_BY_IP = {}   # ip -> (name, email), so re-opens keep the person's identity

# Registered users (name + email + selfie), persisted so the owner keeps a record.
USERS_FILE = os.path.join(DATA_DIR, "users.json")
PHOTOS_DIR = os.path.join(DATA_DIR, "photos")
USERS = {}
USERS_LOCK = threading.Lock()


def hash_id(s):
    h = 0
    for ch in s:
        h = (h * 131 + ord(ch)) & 0xFFFFFFFFFFFF
    return format(h, "x")


def is_local_ip(ip):
    return ip.startswith(("127.", "::1", "192.168.", "10.")) or ip in ("localhost", "0.0.0.0")


def is_owner_request(handler):
    """True only for the browser running ON this Mac (direct to loopback).

    SECURITY: the owner-only endpoints must NOT trust Cf-Connecting-Ip /
    X-Forwarded-For — those are client-supplied and the tunnel (ngrok) passes
    them through, so a remote visitor could spoof 127.0.0.1. Instead we require
    the real TCP peer to be loopback AND the request to carry no proxy/forwarding
    headers. Tunnelled traffic always arrives with forwarding headers appended by
    the tunnel and can only reach the loopback socket through it, so a remote
    client can never satisfy both conditions.
    """
    peer = handler.client_address[0] if handler.client_address else ""
    if peer not in ("127.0.0.1", "::1", "localhost"):
        return False
    fwd = ("X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
           "Cf-Connecting-Ip", "Forwarded", "X-Real-Ip")
    return not any(handler.headers.get(h) for h in fwd)


# Cloud owner access: behind a reverse proxy the loopback check above is False for
# everyone, so owner-only endpoints also accept a shared secret (OWNER_TOKEN) — the
# owner unlocks it once via /#owner=<token>. Compared in constant time.
OWNER_TOKEN = os.environ.get("OWNER_TOKEN", "")
TICK_TOKEN = os.environ.get("TICK_TOKEN", "")       # guards the keep-warm /api/push/tick


def is_owner(handler, token=None):
    if is_owner_request(handler):                       # direct on the Mac → always owner
        return True
    if not OWNER_TOKEN:
        return False
    supplied = token if token is not None else handler.headers.get("X-Owner-Token", "")
    return hmac.compare_digest(str(supplied), OWNER_TOKEN)


def load_users():
    try:
        with open(USERS_FILE) as f:
            for u in json.load(f):
                USERS[u["email"]] = u
    except Exception:
        pass
    try:
        os.makedirs(PHOTOS_DIR, exist_ok=True)
    except Exception:
        pass


def save_photo(email, dataurl):
    """Save a base64 selfie (data:image/...;base64,xxx). Returns a photo id or None."""
    try:
        if not dataurl or "," not in dataurl or not dataurl.startswith("data:image"):
            return None
        raw = base64.b64decode(dataurl.split(",", 1)[1])
        if len(raw) > 800000:          # cap ~800KB
            return None
        pid = hash_id(email)
        with open(os.path.join(PHOTOS_DIR, pid + ".jpg"), "wb") as f:
            f.write(raw)
        return pid
    except Exception:
        return None


def verify_google_token(credential, client_id):
    """Validate a Google ID token via Google's tokeninfo endpoint (stdlib-only)."""
    try:
        url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + urllib.parse.quote(credential)
        data = json.loads(fetch(url, timeout=8))
        if client_id and data.get("aud") != client_id:
            return None
        if data.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
            return None
        if data.get("email_verified") not in ("true", True, None):
            return None
        return {
            "email": data.get("email"),
            "name": data.get("name") or data.get("email"),
            "picture": data.get("picture"),
        }
    except Exception:
        return None


def save_user(name, email, ip, photo=None, avatar_url=None):
    now = time.time()
    with USERS_LOCK:
        u = USERS.get(email)
        if not u:
            u = {"name": name, "email": email, "ip": ip, "first": now, "last": now, "logins": 0}
            USERS[email] = u
        u["name"] = name
        u["last"] = now
        u["logins"] = u.get("logins", 0) + 1
        if photo:
            u["photo"] = photo
        if avatar_url:
            u["avatar_url"] = avatar_url
        try:
            tmp = USERS_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(list(USERS.values()), f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, USERS_FILE)          # atomic — never leaves a torn file
        except Exception:
            pass


def parse_device(ua):
    u = (ua or "").lower()
    if "ipad" in u:
        os_name = "iPad"
    elif "iphone" in u:
        os_name = "iPhone"
    elif "android" in u:
        os_name = "Android"
    elif "windows" in u:
        os_name = "Windows"
    elif "mac os" in u or "macintosh" in u:
        os_name = "Mac"
    elif "cros" in u:
        os_name = "ChromeOS"
    elif "linux" in u:
        os_name = "Linux"
    else:
        os_name = "Unknown device"
    if "edg/" in u or "edga" in u:
        browser = "Edge"
    elif "opr/" in u or "opera" in u:
        browser = "Opera"
    elif "firefox" in u:
        browser = "Firefox"
    elif "chrome" in u or "crios" in u:
        browser = "Chrome"
    elif "safari" in u:
        browser = "Safari"
    elif "curl" in u or "python" in u or "wget" in u or "bot" in u:
        browser = "Bot/Script"
    else:
        browser = "Browser"
    mobile = any(x in u for x in ("iphone", "android", "mobile", "ipad"))
    return os_name, browser, mobile


def client_ip(handler):
    # Behind the Cloudflare tunnel the real visitor IP arrives in these headers.
    return (handler.headers.get("Cf-Connecting-Ip")
            or handler.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            or handler.client_address[0])


def record_visit(handler, path):
    try:
        ip = client_ip(handler)
        ua = handler.headers.get("User-Agent", "")
        key = ip + "|" + ua
        now = time.time()
        is_open = path == "/" or path == "/index.html"
        is_view = path.startswith(("/api/feed", "/api/shorts", "/api/category",
                                    "/api/search", "/api/local", "/api/ask"))
        with VIS_LOCK:
            s = VISITORS.get(key)
            if not s:
                os_name, browser, mobile = parse_device(ua)
                local = ip.startswith(("127.", "::1", "192.168.", "10.")) or ip == "localhost"
                s = {"ip": ip, "os": os_name, "browser": browser, "mobile": mobile,
                     "local": local, "first": now, "last": now, "opens": 0, "views": 0,
                     "name": None, "email": None}
                VISITORS[key] = s
                # carry over a known identity for this IP from a prior session
                ident = IDENTITY_BY_IP.get(ip)
                if ident:
                    s["name"], s["email"] = ident
            s["last"] = now
            if is_open:
                s["opens"] += 1
            if is_view:
                s["views"] += 1
    except Exception:
        pass


# ---------------------------------------------------------------------------
# World-alert category filter: friendly topics → underlying feed categories.
# A topic may also carry a keyword regex (e.g. Disasters) that matches by title
# regardless of how the source feed tagged the story.
# ---------------------------------------------------------------------------
ALERT_TOPICS = [
    {"key": "politics",      "label": "Politics & Govt",     "emoji": "🏛️",
     "cats": ["Politics", "Government"]},
    {"key": "world",         "label": "World & Conflict",    "emoji": "🌍",
     "cats": ["World", "Defence"],
     "kw": r"\b(war|attack|strike|invasion|ceasefire|missile|troops?|border|coup|sanction|hostage|airstrike)\b"},
    {"key": "business",      "label": "Business & Economy",  "emoji": "💼",
     "cats": ["Business", "Economy", "Finance", "Cryptocurrency"]},
    {"key": "tech",          "label": "Tech & Science",      "emoji": "💻",
     "cats": ["Technology", "AI", "Science", "Space", "Startups"]},
    {"key": "disasters",     "label": "Disasters & Weather", "emoji": "🌪️",
     "cats": [],
     "kw": r"\b(earthquake|flood|storm|cyclone|hurricane|tornado|wildfire|tsunami|landslide|"
           r"erupt|volcano|heatwave|cloudburst|disaster|evacuat|blast|explos|derail|collapse|stampede)\b"},
    {"key": "climate_energy","label": "Climate & Energy",    "emoji": "🌡️",
     "cats": ["Climate", "Energy"]},
    {"key": "health",        "label": "Health",              "emoji": "⚕️",
     "cats": ["Health"]},
    {"key": "crime",         "label": "Crime",               "emoji": "🚔",
     "cats": ["Crime"]},
    {"key": "sports",        "label": "Sports",              "emoji": "⚽",
     "cats": ["Sports"]},
    {"key": "entertainment", "label": "Entertainment",       "emoji": "🎬",
     "cats": ["Entertainment"]},
]
ALERT_TOPIC_BY_KEY = {t["key"]: t for t in ALERT_TOPICS}
# Precompile each topic's optional keyword regex once.
for _t in ALERT_TOPICS:
    _t["_kw_re"] = re.compile(_t["kw"], re.I) if _t.get("kw") else None


def world_topic_match(story, topic_keys):
    """True if a world story matches ANY of the selected alert topics.
    Empty/None selection means 'no filter' → always True."""
    if not topic_keys:
        return True
    cat = story.get("category", "")
    title = story.get("title", "")
    for k in topic_keys:
        t = ALERT_TOPIC_BY_KEY.get(k)
        if not t:
            continue
        if cat in t["cats"]:
            return True
        if t["_kw_re"] and t["_kw_re"].search(title):
            return True
    return False


# ---------------------------------------------------------------------------
# Alert computation (shared by /api/alerts and the background push loop)
# ---------------------------------------------------------------------------
# Urgent-sounding headlines worth a push notification.
ALERT_RE = re.compile(
    r"\b(breaking|killed|dead|attack|shoot|fire|blaze|crash|accident|earthquake|"
    r"flood|explos|emergency|evacuat|storm|cyclone|rain|alert|protest|riot|"
    r"shutdown|curfew|warning|rescue|landslide|outage|blackout|derail|collapse|"
    r"missing|hijack|hostage|blast|stampede|heatwave|cloudburst)\b", re.I)


def alert_is_urgent(s):
    if ALERT_RE.search(s.get("title", "")):
        return True
    return any(ALERT_RE.search(src.get("title", "")) for src in s.get("sources", []))


def fmt_alert(s, urgent, scope):
    # src_ids = stable ids of every article in the cluster. Dedup uses these
    # (not the lead's story_id, which changes as a developing story gains updates
    # and the lead rotates), so a story is pushed once, not once per update.
    src_ids = [article_id(src.get("link", ""), src.get("title", ""))
               for src in s.get("sources", [])] or [s.get("story_id")]
    return {
        "id": s.get("story_id"),
        "title": s.get("title", ""),
        "publisher": s.get("publisher", ""),
        "link": s.get("link", ""),
        "importance": s.get("importance", 0),
        "urgent": urgent,
        "scope": scope,            # "local" or "world"
        "published": s.get("published", ""),
        "published_ts": s.get("published_ts", 0) or 0,
        "src_ids": src_ids,
    }


def compute_local_alerts(city, topics="", since=0.0, india=True):
    """Fresh urgent/high-importance stories for a city (newer than since, <18h old)."""
    now = time.time()
    q = (f'"{city}" (breaking OR police OR fire OR accident OR crash OR weather OR '
         f'flood OR traffic OR protest OR emergency OR alert OR local)'
         f'{(" " + topics) if topics else ""}')
    gn = STORE.google_news(q, india=india, category="Local", ttl=180)
    out = []
    for s in (build_story(c) for c in cluster(gn)):
        ts = s.get("published_ts", 0) or 0
        if ts <= since or ts < now - 18 * 3600:
            continue
        urgent = alert_is_urgent(s)
        if not urgent and s.get("importance", 0) < 55:
            continue
        out.append(fmt_alert(s, urgent, "local"))
    out.sort(key=lambda x: x["published_ts"], reverse=True)
    return out


def compute_world_alerts(since=0.0, topic_keys=None):
    """Fresh high-impact world stories (importance>=72, 3+ publishers, <12h old)."""
    now = time.time()
    arts = filter_articles(since_hours=12)
    out = []
    for s in (build_story(c) for c in cluster(arts)):
        ts = s.get("published_ts", 0) or 0
        if ts <= since or ts < now - 12 * 3600:
            continue
        if s.get("importance", 0) < 72 or s.get("num_publishers", 1) < 3:
            continue
        if not world_topic_match(s, topic_keys or []):
            continue
        item = fmt_alert(s, alert_is_urgent(s), "world")
        item["category"] = s.get("category", "")
        out.append(item)
    out.sort(key=lambda x: (x["importance"], x["published_ts"]), reverse=True)
    return out


# ---------------------------------------------------------------------------
# Web Push (closed-app notifications). The server watches alerts per
# subscription and pings the browser's push service; the service worker then
# fetches /api/push/pending and shows the notification — the app/tab can be
# fully closed. Crypto (VAPID) lives in push.py, stdlib only.
# ---------------------------------------------------------------------------
PUSH_FILE = os.path.join(DATA_DIR, "push_subs.json")
PUSH_LOCK = threading.Lock()
PUSH_SAVE_LOCK = threading.Lock()
PUSH_SUBS = {}          # key -> {endpoint, prefs, seen[], since, pending[], created, send_failed}
RECENT_PUSHED = {}      # alert id -> alert entry (cold-open deep-link lookup)
RECENT_LOCK = threading.Lock()
PUSH_INTERVAL = 300     # seconds between server-side alert checks
MAX_PUSH_SUBS = 500     # hard cap so a tunnel visitor can't grow the store unbounded
# Endpoint hosts we accept (real push services). Blocks arbitrary SSRF-ish targets.
PUSH_HOST_RE = re.compile(
    r"\.(googleapis\.com|mozilla\.com|mozaws\.net|windows\.com|microsoft\.com|apple\.com)$", re.I)
VAPID_KEYS = webpush.load_or_create_keys(os.path.join(DATA_DIR, "vapid.json"))


def push_key(endpoint):
    return hashlib.sha256(endpoint.encode()).hexdigest()[:24]


def valid_push_endpoint(endpoint):
    if not isinstance(endpoint, str) or not endpoint.startswith("https://") or len(endpoint) > 1024:
        return False
    try:
        host = urllib.parse.urlparse(endpoint).hostname or ""
    except Exception:
        return False
    return bool(PUSH_HOST_RE.search(host))


def load_push_subs():
    global PUSH_SUBS
    try:
        with open(PUSH_FILE) as f:
            PUSH_SUBS = json.load(f)
    except FileNotFoundError:
        PUSH_SUBS = {}
    except Exception as e:
        # Corrupt file: keep whatever we have (empty) but don't hide it entirely.
        print("warning: could not read push_subs.json:", e)
        PUSH_SUBS = {}


def save_push_subs():
    """Atomic, serialized write so overlapping saves / crashes can't corrupt it."""
    try:
        with PUSH_LOCK:
            snapshot = json.dumps(PUSH_SUBS)
        with PUSH_SAVE_LOCK:
            tmp = PUSH_FILE + ".tmp"
            with open(tmp, "w") as f:
                f.write(snapshot)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, PUSH_FILE)
    except Exception:
        pass


def _notif_title(a, city):
    if a.get("scope") == "world":
        return "🌍 Major world news"
    tag = "🚨 Breaking near you" if a.get("urgent") else "🔔 Local update"
    return f"{tag} · {city}" if city else tag


def remember_pushed(a):
    with RECENT_LOCK:
        RECENT_PUSHED[a["id"]] = a
        while len(RECENT_PUSHED) > 400:                      # bounded lookup cache
            RECENT_PUSHED.pop(next(iter(RECENT_PUSHED)), None)


def push_check_all():
    """One pass: compute fresh alerts per subscription, queue + send pushes."""
    with PUSH_LOCK:
        items = list(PUSH_SUBS.items())
    if not items:
        return
    changed = False
    for key, sub in items:
        prefs = sub.get("prefs") or {}
        since = float(sub.get("since", 0) or 0)
        seen = set(sub.get("seen") or [])
        incoming = []
        try:
            city = (prefs.get("city") or "").strip()
            if prefs.get("local", True) and city:
                incoming += compute_local_alerts(city, prefs.get("topics", ""), since)
            wc = prefs.get("worldCats", None)   # None = all topics, [] = none
            if prefs.get("world", True) and wc != []:
                incoming += compute_world_alerts(since, wc or None)
        except Exception:
            continue
        # Dedup on the CLUSTER's article ids: skip a story if ANY of its current
        # source articles was already pushed (handles lead rotation as a story develops).
        fresh = []
        for a in incoming:
            sids = a.get("src_ids") or [a.get("id")]
            if any(sid in seen for sid in sids):
                continue
            fresh.append(a)
            seen.update(sids)
            if len(fresh) >= 3:
                break
        for a in fresh:
            a["ntitle"] = _notif_title(a, (prefs.get("city") or "").strip())
            remember_pushed(a)
        with PUSH_LOCK:
            live = PUSH_SUBS.get(key)
            if not live:
                continue
            if fresh:
                new_ids = []
                for a in fresh:
                    new_ids += (a.get("src_ids") or [a.get("id")])
                live["seen"] = ((live.get("seen") or []) + new_ids)[-600:]
                live["pending"] = ((live.get("pending") or []) + fresh)[-12:]
            # attempt a send if there's something new OR a previous send failed transiently
            attempt = bool(fresh) or bool(live.get("send_failed"))
            endpoint = live.get("endpoint", "")
        if not attempt:
            continue
        changed = True
        status, _detail = webpush.send_push(VAPID_KEYS, endpoint)
        with PUSH_LOCK:
            live = PUSH_SUBS.get(key)
            if not live:
                continue
            if 200 <= status < 300:
                live["send_failed"] = False
            elif status in (401, 403, 404, 410):             # dead/invalid subscription
                PUSH_SUBS.pop(key, None)
            else:                                            # transient (0/5xx): retry next cycle
                live["send_failed"] = True
    if changed:
        save_push_subs()


def push_loop():
    while True:
        time.sleep(PUSH_INTERVAL)
        try:
            push_check_all()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except Exception:
            data = {}
        try:
            if parsed.path == "/api/login":
                return self.api_login(data)
            if parsed.path == "/api/google-login":
                return self.api_google_login(data)
            if parsed.path == "/api/push/subscribe":
                return self.api_push_subscribe(data)
            if parsed.path == "/api/push/unsubscribe":
                return self.api_push_unsubscribe(data)
            if parsed.path == "/api/push/pending":
                return self.api_push_pending(data)
            return self._send(404, {"error": "not found"})
        except BrokenPipeError:
            pass
        except Exception as e:
            self._send(500, {"error": str(e)})

    def api_google_login(self, data):
        cfg = get_config()
        client_id = cfg.get("google_client_id", "")
        info = verify_google_token(data.get("credential", ""), client_id)
        if not info or not info.get("email"):
            return self._send(401, {"ok": False, "error": "Google sign-in could not be verified."})
        name = (info["name"] or info["email"])[:80]
        email = info["email"][:120]
        picture = info.get("picture") or ""
        record_visit(self, "/")
        ip = client_ip(self)
        key = ip + "|" + self.headers.get("User-Agent", "")
        with VIS_LOCK:
            IDENTITY_BY_IP[ip] = (name, email)
            s = VISITORS.get(key)
            if s:
                s["name"], s["email"] = name, email
        save_user(name, email, ip, avatar_url=picture)
        return self._send(200, {"ok": True, "name": name, "email": email})

    def api_login(self, data):
        name = (str(data.get("name") or "")).strip()[:80]
        email = (str(data.get("email") or "")).strip()[:120]
        if not name or "@" not in email or "." not in email.split("@")[-1]:
            return self._send(400, {"ok": False, "error": "A name and a valid email are required."})
        record_visit(self, "/")
        ip = client_ip(self)
        key = ip + "|" + self.headers.get("User-Agent", "")
        pid = save_photo(email, data.get("photo"))
        with VIS_LOCK:
            IDENTITY_BY_IP[ip] = (name, email)
            s = VISITORS.get(key)
            if s:
                s["name"], s["email"] = name, email
        save_user(name, email, ip, pid)
        return self._send(200, {"ok": True})

    # ---- Web Push subscription management -------------------------------
    def api_push_subscribe(self, data):
        sub_in = data.get("subscription") or {}
        endpoint = str(sub_in.get("endpoint") or "")
        if not valid_push_endpoint(endpoint):
            return self._send(400, {"ok": False, "error": "bad subscription"})
        key = push_key(endpoint)
        # Cap the store so a stranger on the tunnel can't grow it without bound.
        with PUSH_LOCK:
            if key not in PUSH_SUBS and len(PUSH_SUBS) >= MAX_PUSH_SUBS:
                return self._send(429, {"ok": False, "error": "subscription limit reached"})
        prefs_in = data.get("prefs")     # may be absent (pushsubscriptionchange)
        if prefs_in is not None:
            wc = prefs_in.get("worldCats", None)
            if wc is not None and not (isinstance(wc, list)
                                       and all(isinstance(x, str) for x in wc)):
                wc = None
            prefs_in = {
                "world": bool(prefs_in.get("world", True)),
                "local": bool(prefs_in.get("local", True)),
                "worldCats": wc,
                "city": str(prefs_in.get("city") or "")[:80],
                "topics": str(prefs_in.get("topics") or "")[:200],
            }
        now = time.time()
        default_prefs = {"world": True, "local": True, "worldCats": None,
                         "city": "", "topics": ""}
        with PUSH_LOCK:
            # browser rotated the subscription → migrate the old record's state
            prev = None
            prev_ep = str(data.get("prev_endpoint") or "")
            if prev_ep and prev_ep != endpoint:
                prev = PUSH_SUBS.pop(push_key(prev_ep), None)
            cur = PUSH_SUBS.get(key)
            if cur is None:
                base = prev or {}
                cur = {"endpoint": endpoint,
                       "prefs": base.get("prefs", default_prefs),
                       "seen": base.get("seen", []),
                       "since": base.get("since", now),
                       "pending": [],
                       "created": base.get("created", now)}
                PUSH_SUBS[key] = cur
            if prefs_in is not None:
                cur["prefs"] = prefs_in
        save_push_subs()
        return self._send(200, {"ok": True})

    def api_push_unsubscribe(self, data):
        endpoint = str(data.get("endpoint") or "")
        with PUSH_LOCK:
            PUSH_SUBS.pop(push_key(endpoint), None)
        save_push_subs()
        return self._send(200, {"ok": True})

    def api_push_pending(self, data):
        """Called by the service worker on a push wake-up: hand over queued alerts."""
        endpoint = str(data.get("endpoint") or "")
        alerts = []
        with PUSH_LOCK:
            sub = PUSH_SUBS.get(push_key(endpoint))
            if sub:
                alerts = sub.get("pending") or []
                sub["pending"] = []
        if alerts:
            save_push_subs()
        return self._send(200, {"alerts": alerts})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        def g(name, default=None):
            v = qs.get(name)
            return v[0] if v else default

        record_visit(self, path)
        try:
            if path == "/" or path == "/index.html":
                return self.serve_static("index.html")
            if path.startswith("/web/") or path in ("/app.js", "/styles.css"):
                return self.serve_static(os.path.basename(path))
            if path == "/manifest.json" or path.endswith(".png"):
                return self.serve_static(os.path.basename(path))
            if path == "/sw.js":
                return self.serve_static("sw.js")
            if path == "/api/config":
                cfg = get_config()
                return self._send(200, {"google_client_id": cfg.get("google_client_id", "")})
            if path == "/api/refresh":
                STORE.gn_cache.clear()
                threading.Thread(target=STORE.refresh, daemon=True).start()
                return self._send(200, {"ok": True, "refreshing": True})
            if path.startswith("/photo/"):
                if not is_owner(self, token=g("token")):   # <img> can't send a header → ?token=
                    return self._send(403, "forbidden", "text/plain")
                return self.serve_photo(os.path.basename(path))
            if path == "/api/visitors":
                if not is_owner(self, token=g("token")):   # owner-only — never on the share link
                    return self._send(403, {"error": "Who's Watching is visible to the owner only."})
                return self.api_visitors()
            if path == "/api/status":
                return self._send(200, {
                    "loading": STORE.loading,
                    "refreshing": STORE.refreshing,
                    "count": len(STORE.articles),
                    "last_refresh": STORE.last_refresh,
                    "errors": STORE.errors[:8],
                    "categories": F.CATEGORIES,
                    "states": F.INDIAN_STATES,
                    "countries": sorted({p["country"] for p in F.PUBLISHERS.values()}),
                    "publishers": sorted(F.PUBLISHERS.keys()),
                })
            if path == "/api/feed":
                return self.api_feed(g)
            if path == "/api/shorts":
                return self.api_shorts(g)
            if path == "/api/trends":
                scope = g("scope")
                arts = filter_articles(scope=scope, since_hours=24)
                return self._send(200, {"trends": trends(arts)})
            if path == "/api/map":
                return self.api_map()
            if path == "/api/category":
                return self.api_category(g)
            if path == "/api/search":
                return self.api_search(g)
            if path == "/api/local":
                return self.api_local(g)
            if path == "/api/alerts":
                return self.api_alerts(g)
            if path == "/api/push/vapid-key":
                return self._send(200, {"key": VAPID_KEYS["public_b64"]})
            if path == "/api/push/tick":
                # Hit by an external cron (cron-job.org) every ~10 min: keeps a
                # free/sleeping cloud instance warm AND drives one push pass. Guarded
                # by TICK_TOKEN so strangers can't trigger it.
                if not TICK_TOKEN or not hmac.compare_digest(g("token", ""), TICK_TOKEN):
                    return self._send(403, {"ok": False})
                threading.Thread(target=push_check_all, daemon=True).start()
                return self._send(200, {"ok": True})
            if path == "/api/alert-lookup":
                with RECENT_LOCK:
                    hit = RECENT_PUSHED.get(g("id", ""))
                return self._send(200, {"alert": hit})
            if path == "/api/alert-topics":
                return self._send(200, {"topics": [
                    {"key": t["key"], "label": t["label"], "emoji": t["emoji"]}
                    for t in ALERT_TOPICS]})
            if path == "/api/ask":
                arts = filter_articles(since_hours=48)
                return self._send(200, ask(g("q", ""), arts))
            return self._send(404, {"error": "not found"})
        except BrokenPipeError:
            pass
        except Exception as e:
            self._send(500, {"error": str(e)})

    # -- endpoints --
    def api_feed(self, g):
        scope = g("scope")  # world / india / None
        arts = filter_articles(
            scope=scope,
            category=g("category"),
            country=g("country"),
            publisher=g("publisher"),
            q=g("q"),
            since_hours=int(g("hours")) if g("hours") else None,
            min_reliability=int(g("min_reliability", "0")),
            bias=g("bias"),
            state=g("state"),
        )
        clusters = cluster(arts)
        stories = [build_story(c) for c in clusters]
        sort = g("sort", "time")
        if sort == "importance":
            stories.sort(key=lambda s: (s["importance"], s["published_ts"]), reverse=True)
        elif sort == "publishers":
            stories.sort(key=lambda s: (s["num_publishers"], s["published_ts"]), reverse=True)
        else:
            stories.sort(key=lambda s: s["published_ts"], reverse=True)
        page = int(g("page", "0"))
        size = int(g("size", "30"))
        total = len(stories)
        stories = stories[page * size:(page + 1) * size]
        enrich_many(stories, cap=16)
        return self._send(200, {"stories": stories, "total": total,
                                 "page": page, "size": size,
                                 "loading": STORE.loading})

    def api_shorts(self, g):
        """Top 20 stories of the day, Inshorts-style — importance-ranked, image-preferred."""
        scope = g("scope") or None
        cat = g("cat") or None
        arts = filter_articles(scope=scope, category=cat, since_hours=36)
        stories = [build_story(c) for c in cluster(arts)]
        # Rank: importance first, then prefer ones with an image and a real brief.
        def rank(s):
            has_img = 1 if s.get("image") else 0
            brief = s.get("summaries", {}).get("brief", "")
            has_brief = 1 if len(brief.split()) >= 12 else 0
            return (s["importance"], has_img + has_brief, s["published_ts"])
        stories.sort(key=rank, reverse=True)
        top = stories[:20]
        enrich_many(top, cap=20, min_words=45)   # fuller ~60-word briefs for the deck
        return self._send(200, {"stories": top, "total": len(stories)})

    def api_category(self, g):
        cat = g("cat", "World")
        india = g("india") == "1"
        # combine direct-feed coverage with a Google News topive query
        direct = filter_articles(category=cat, scope="india" if india else None)
        gq = F.CATEGORY_QUERIES.get(cat, cat)
        gn = STORE.google_news(gq, india=india, category=cat)
        merged = {a["id"]: a for a in direct}
        for a in gn:
            merged.setdefault(a["id"], a)
        arts = sorted(merged.values(), key=lambda a: a["published_ts"], reverse=True)
        stories = [build_story(c) for c in cluster(arts)]
        stories.sort(key=lambda s: s["published_ts"], reverse=True)
        out = stories[:40]
        enrich_many(out, cap=16)
        return self._send(200, {"stories": out, "total": len(stories)})

    def api_search(self, g):
        q = g("q", "").strip()
        if not q:
            return self._send(200, {"stories": [], "total": 0})
        india = g("india") == "1"
        local = filter_articles(q=q)
        gn = STORE.google_news(q, india=india, category="Search")
        merged = {a["id"]: a for a in local}
        for a in gn:
            merged.setdefault(a["id"], a)
        arts = sorted(merged.values(), key=lambda a: a["published_ts"], reverse=True)
        stories = [build_story(c) for c in cluster(arts)]
        stories.sort(key=lambda s: (s["importance"], s["published_ts"]), reverse=True)
        out = stories[:40]
        enrich_many(out, cap=16)
        return self._send(200, {"stories": out, "total": len(stories)})

    def api_local(self, g):
        city = g("city", "").strip()
        radius = g("radius", "25")
        if not city:
            return self._send(200, {"stories": [], "total": 0, "city": ""})
        # Build a local-news query; radius is informational (RSS has no geo filter).
        topics = g("topics", "")
        q = f'"{city}" (local OR traffic OR weather OR crime OR civic OR municipal OR metro OR power OR water OR election){(" " + topics) if topics else ""}'
        india = g("india", "1") == "1"
        gn = STORE.google_news(q, india=india, category="Local", ttl=300)
        stories = [build_story(c) for c in cluster(gn)]
        stories.sort(key=lambda s: s["published_ts"], reverse=True)
        return self._send(200, {"stories": stories[:40], "total": len(stories),
                                 "city": city, "radius": radius})

    def api_alerts(self, g):
        """New alerts since `since` (epoch secs): local (if city set) + world high-impact."""
        now = time.time()
        try:
            since = float(g("since", "0") or 0)
        except Exception:
            since = 0.0
        city = g("city", "").strip()
        local_out = compute_local_alerts(city, g("topics", ""), since,
                                         india=g("india", "1") == "1") if city else []
        world_out = []
        if g("world", "1") == "1":
            topic_keys = [k for k in g("wtopics", "").split(",") if k]
            world_out = compute_world_alerts(since, topic_keys)
        return self._send(200, {"alerts": local_out[:8], "world": world_out[:6],
                                 "city": city, "now": now})

    def api_map(self):
        counts = {}
        with STORE.lock:
            pool = list(STORE.articles)
        # Count by mentioned country across titles + by source country.
        for c in F.MAP_COUNTRIES:
            cl = c.lower()
            n = sum(1 for a in pool if cl in a["title"].lower()
                    or (a["country"] == c))
            top = [a for a in pool if cl in a["title"].lower()][:5]
            counts[c] = {
                "count": n,
                "top": [{"title": a["title"], "publisher": a["publisher"],
                         "link": a["link"], "importance": a["reliability"]} for a in top],
            }
        return self._send(200, {"countries": counts})

    def api_visitors(self):
        now = time.time()
        with VIS_LOCK:
            sessions = list(VISITORS.values())
        # newest live session per signed-in email + any anonymous live sessions
        live_by_email, anon = {}, []
        for s in sessions:
            em = s.get("email")
            if em:
                if em not in live_by_email or s["last"] > live_by_email[em]["last"]:
                    live_by_email[em] = s
            else:
                anon.append(s)
        out = []
        with USERS_LOCK:
            users = list(USERS.values())
        # every signed-in person, durable — shown with photo even when offline
        for u in users:
            em = u["email"]
            live = live_by_email.get(em)
            last = max(u.get("last", 0), live["last"] if live else 0)
            out.append({
                "name": u["name"], "email": em, "photo": u.get("photo"),
                "avatar_url": u.get("avatar_url"), "registered": True,
                "os": live["os"] if live else None, "browser": live["browser"] if live else None,
                "mobile": live["mobile"] if live else False,
                "ip": (live["ip"] if live else u.get("ip")), "local": live["local"] if live else False,
                "opens": u.get("logins", 1), "views": live["views"] if live else 0,
                "first": u.get("first", last), "last": last,
                "active": bool(live) and (now - live["last"]) < 120,
            })
        # anonymous live sessions (e.g. the owner on localhost, not signed in)
        for s in anon:
            out.append({
                "name": None, "email": None, "photo": None, "registered": False,
                "os": s["os"], "browser": s["browser"], "mobile": s["mobile"],
                "ip": s["ip"], "local": s["local"], "opens": s["opens"], "views": s["views"],
                "first": s["first"], "last": s["last"], "active": (now - s["last"]) < 120,
            })
        out.sort(key=lambda x: (x["active"], x["last"]), reverse=True)
        active = sum(1 for x in out if x["active"])
        registered = sum(1 for x in out if x["registered"])
        return self._send(200, {"visitors": out, "total": len(out),
                                 "active": active, "remote": registered,
                                 "registered": registered})

    def serve_static(self, name):
        fp = os.path.join(WEB, name)
        if not os.path.isfile(fp):
            return self._send(404, "not found", "text/plain")
        ctype = ("text/html" if name.endswith(".html") else
                 "application/javascript" if name.endswith(".js") else
                 "text/css" if name.endswith(".css") else
                 "application/json" if name.endswith(".json") else
                 "image/png" if name.endswith(".png") else "application/octet-stream")
        with open(fp, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_photo(self, name):
        name = os.path.basename(name)
        fp = os.path.join(PHOTOS_DIR, name)
        if not name.endswith(".jpg") or not os.path.isfile(fp):
            return self._send(404, "not found", "text/plain")
        with open(fp, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    load_users()
    load_push_subs()
    t = threading.Thread(target=STORE.loop, daemon=True)
    t.start()
    threading.Thread(target=push_loop, daemon=True).start()   # background push checks
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"News Intelligence Dashboard → http://localhost:{PORT}")
    print("Fetching live RSS in the background… (first load may take a few seconds)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
