# 🛰️ News Intelligence Dashboard

A self-contained, AI-style **news operating system** that runs entirely on your Mac.
It pulls **real, live news** from ~50 free public RSS feeds (BBC, Reuters, The Guardian,
Al Jazeera, NPR, NDTV, The Hindu, Times of India, Indian Express, TechCrunch, and more),
plus Google News for search and long-tail topics — **no API keys, no signups, no paid services.**

Nothing is fabricated. Every story links to its real source, every "Ask" answer quotes real
headlines, and bias/reliability are approximate ratings from public media-watchdog aggregators.

---

## ▶️ Run it

```bash
cd ~/Downloads/news-intel
python3 server.py
```

Then open **http://localhost:8770** in your browser.

Or just **double-click `start.command`** in Finder.

### 📱 Install on your phone (Android / iPhone)
Open the site in Chrome/Safari on your phone → menu → **"Add to Home Screen"**. It installs
as a full-screen app (icon, no browser bar) thanks to the bundled web manifest. The layout is
fully responsive with a bottom tab bar + "More" menu for phones.

### 🔗 Share it with someone on another network
**Double-click `share.command`.** It starts the server (if needed) and opens a free Cloudflare
tunnel, printing a public link like `https://xxxx.trycloudflare.com` — send that to anyone.
Notes: the link only works while your Mac is on and that window stays open; it's public (no login),
fine for a read-only news reader; and you get a *new* link each time you run it.
Requires the bundled `cloudflared` binary (already in this folder).

> First load fetches ~50 feeds in parallel and takes a few seconds — you'll see skeleton
> loaders, then the feed fills in. It auto-refreshes every 10 minutes.

Requires only **Python 3** (built into macOS) — no `pip install`, no Node, no database.

---

## ✨ What's inside

| Feature | What it does |
|---|---|
| **In Short** | Inshorts-style deck of the day's top 20 stories — full-screen swipeable cards (↑↓ keys / swipe / scroll), image + 60-word brief + source |
| **Brief snippets** | Every story shows a tight ~60-word brief. When a feed ships only a headline, the article's own published description (og:description / lead paragraphs) is fetched to fill it — real text, prose-filtered, never fabricated, cached |
| **Global feed** | Worldwide news, filter by category, time, importance, reliability, political lean |
| **India feed** | Dedicated tab across Indian publishers, filter by state/UT |
| **Local news** | Enter a city (or use GPS) for local/traffic/weather/civic/crime stories |
| **Desks** | Technology, AI, Business, Markets, Science, Space, Sports, Health, Crypto |
| **Cross-source comparison** | Auto-merges the same event reported by multiple outlets, side-by-side with reliability & bias |
| **AI summaries** | 30-sec, 2-min, bullets, ELI5, detailed, timeline — extractive from real source text |
| **Source transparency** | Publisher, country, ownership, reliability score, political-lean dial, archive link |
| **Timeline** | Chronological view of how a story developed across publishers |
| **Trends** | Fastest-growing terms worldwide & in India (last 8h vs prior) |
| **World map** | Coverage by country — click to see top stories |
| **Ask the News** | Cited, extractive Q&A over the live feed (never invents facts) |
| **Search** | Across the live feed + Google News, merged and de-duplicated |
| **Reading tools** | Dark/light, listen (text-to-speech), translate, bookmark, history |
| **Command palette** | ⌘K to jump anywhere |

### Keyboard shortcuts
`⌘K` palette · `/` search · `H` home · `B` breaking · `T` trending · `W` world · `I` India · `L` local · `M` map · `A` ask · `Esc` close

---

## 🧱 How it's built

```
news-intel/
├── server.py     # Python stdlib backend: RSS fetch + parse, clustering,
│                 # trends, extractive summaries, retrieval ("Ask"), HTTP API
├── feeds.py      # Curated source catalogue + publisher bias/reliability ratings
├── web/
│   ├── index.html
│   ├── styles.css   # glassmorphism, dark-first, responsive
│   └── app.js       # vanilla JS SPA — feed, drawer, trends, map, ask, search
├── start.command    # double-click launcher
└── README.md
```

**No external dependencies.** The backend is pure Python 3 standard library
(`urllib`, `xml.etree`, `http.server`, `concurrent.futures`).

### Honesty by design
- **Bias & reliability** are coarse, approximate ratings drawn from public media-watchdog
  aggregators (AllSides, Media Bias/Fact Check). They are labelled "approximate" everywhere
  and should be treated as a rough signal, not ground truth.
- **Summaries** are *extractive* — built from the publisher's own RSS text, never generated.
  If a feed gives only a headline, the summary is short; open the source for the full article.
- **"Ask"** retrieves and quotes real headlines currently in the feed, with citations. It is
  not a generative model, so it cannot invent facts (the trade-off: answers are quotes, not prose).

### Want richer data later?
The architecture already supports it — drop a GNews / NewsAPI / Guardian key into a fetch
helper in `server.py` and add the source to `feeds.py`. Everything else (clustering, scoring,
summaries, UI) works the same.
