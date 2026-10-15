# 📰 News Intelligence Dashboard

**A self-contained news reader that clusters the same story across ~50 sources, shows you each outlet's bias & reliability, summarizes without hallucinating, and pushes breaking-news alerts to your phone — even when the app is closed.**

🔗 **Live demo:** https://news-intel-sc30.onrender.com  *(sign in with Google)*

Built as a solo project in **pure Python standard library** — no frameworks, no database, no paid APIs, no build step. One `server.py`, a few static files, done.

---

## Why

Most news apps show you one source's take and call it the truth. I wanted a dashboard that:
- puts the **same story from every outlet side by side**, so spin is obvious,
- labels each source's **political lean and reliability**,
- summarizes with the publisher's **own words** (so it can't invent facts), and
- actually **notifies me** when something breaks near me or around the world.

So I built it.

## ✨ What it does

| Feature | What it means |
|---|---|
| **Cross-source clustering** | The same event from BBC, Reuters, NDTV, Al Jazeera… grouped into one story, so you see every angle at once. |
| **Bias & reliability signals** | Each source tagged with an approximate political lean + reliability rating. |
| **"In Short" deck** | Inshorts-style swipeable cards — the day's top 20, one tap each. |
| **Ask the News** | Ask a question, get an answer built only from **real, cited headlines** (extractive — no made-up facts). |
| **Trends & World Map** | Rising keywords + an interactive map of where the news is happening. |
| **Local news** | City-level coverage — traffic, civic, crime, weather — for any town you type. |
| **🔔 Smart push alerts** | Server-side Web Push: breaking news reaches your phone **with the app fully closed**. Pick exactly which world topics (politics, disasters, sports…) or local city alerts you want. |
| **Who's Watching** | Owner-only log of who's signed in. |
| **Installable (PWA)** | Add to Home Screen on iPhone/Android — runs like a native app, no store needed. |

## 🧠 How it works

```
~50 RSS feeds ──▶ parallel fetch (ThreadPoolExecutor)
                     │
                     ▼
         Jaccard clustering on title signatures  ──▶ one story, many sources
                     │
                     ▼
     importance score + extractive summaries + bias/reliability merge
                     │
     ┌───────────────┼────────────────┐
     ▼               ▼                 ▼
  HTTP API      background          Web Push loop
 (http.server)  refresh (10 min)   (5 min → FCM/APNs)
```

- **Summaries are extractive**, pulled from each publisher's own RSS text — it rephrases nothing, so it can't hallucinate.
- **Web Push built from scratch**: VAPID (P-256 ECDSA signing) hand-rolled in pure Python — no `cryptography`, no `pywebpush`. The server sends the push; a service worker wakes and shows it even when the tab is closed.
- **No database**: state lives in small JSON files; news lives in memory and refreshes on a background thread.

## 🛠 Tech

**Backend:** Python 3 (standard library only) · `http.server` · `ThreadingHTTPServer` · hand-rolled VAPID/ECDSA
**Frontend:** vanilla JS single-page app · Service Worker · Web Push · PWA (installable, offline shell)
**Data:** ~50 free RSS feeds + Google News RSS · no API keys
**Deploy:** GitHub → Render (free tier) · auto-HTTPS · a cron pinger keeps it awake 24/7

## 🚀 Run it yourself

```bash
python3 server.py          # → http://localhost:8770
```

That's the whole setup. No `pip install`, no Node, no config. To deploy, the included `render.yaml` turns it into a one-click Render Blueprint (set `GOOGLE_CLIENT_ID`, `OWNER_TOKEN`, `TICK_TOKEN`, `VAPID_JSON`).

## 📁 Layout

```
server.py     — HTTP API, RSS fetch/parse, clustering, summaries, push loop
push.py       — pure-Python VAPID / Web Push (P-256 ECDSA)
feeds.py      — ~50 curated feeds + source bias/reliability metadata
web/          — vanilla-JS SPA, service worker, PWA manifest
render.yaml   — one-click cloud deploy
```

---

*A personal project — built to learn by shipping. Bias/reliability ratings are approximate, sourced from public media-watchdog aggregators.*
