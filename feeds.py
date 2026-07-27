"""
feeds.py — Curated source catalogue for the News Intelligence Dashboard.

Two things live here:

1. PUBLISHERS — metadata for each outlet: country, ownership, an approximate
   *bias* label and a *reliability* score (0-100). These ratings are coarse and
   derived from publicly available media-watchdog aggregators (AllSides,
   Media Bias / Fact Check, Reporters Without Borders). They are intentionally
   approximate and are surfaced in the UI as "approximate, from public ratings"
   — never presented as precise truth.

2. FEEDS — the curated list of real, free, public RSS endpoints we poll. Each is
   tagged with publisher, category and scope so the backend can filter without
   guessing. Feeds that 404 or change are skipped gracefully at fetch time.

In addition to these, the backend builds Google News RSS queries on demand for
search, long-tail categories, countries and local news.
"""

# --- Bias buckets (left .. right) and a numeric position for the UI dial ----
BIAS_POS = {
    "left": -2, "center-left": -1, "center": 0,
    "center-right": 1, "right": 2, "mixed": 0, "n/a": 0,
}

# --- Publisher catalogue ----------------------------------------------------
# reliability: 0-100 (factual-reporting track record, approximate)
PUBLISHERS = {
    "BBC News":          dict(country="United Kingdom", bias="center",        reliability=92, ownership="Public (UK licence fee)"),
    "Reuters":           dict(country="United Kingdom", bias="center",        reliability=96, ownership="Thomson Reuters (public co.)"),
    "Associated Press":  dict(country="United States",  bias="center",        reliability=95, ownership="Non-profit cooperative"),
    "The Guardian":      dict(country="United Kingdom", bias="center-left",   reliability=86, ownership="Scott Trust (non-profit)"),
    "Al Jazeera":        dict(country="Qatar",          bias="mixed",         reliability=78, ownership="Qatar government funded"),
    "NPR":               dict(country="United States",  bias="center-left",   reliability=88, ownership="Non-profit / public radio"),
    "CNN":               dict(country="United States",  bias="center-left",   reliability=74, ownership="Warner Bros. Discovery"),
    "Deutsche Welle":    dict(country="Germany",        bias="center",        reliability=88, ownership="Public (German state)"),
    "France 24":         dict(country="France",         bias="center",        reliability=85, ownership="Public (France Médias)"),
    "CNBC":              dict(country="United States",  bias="center-right",  reliability=82, ownership="NBCUniversal / Comcast"),
    "The Verge":         dict(country="United States",  bias="center",        reliability=82, ownership="Vox Media"),
    "Ars Technica":      dict(country="United States",  bias="center",        reliability=88, ownership="Condé Nast"),
    "TechCrunch":        dict(country="United States",  bias="center",        reliability=80, ownership="Yahoo Inc."),
    "Wired":             dict(country="United States",  bias="center-left",   reliability=83, ownership="Condé Nast"),
    "Science Daily":     dict(country="United States",  bias="center",        reliability=90, ownership="Independent"),
    "Space.com":         dict(country="United States",  bias="center",        reliability=86, ownership="Future plc"),
    "ESPN":              dict(country="United States",  bias="n/a",           reliability=82, ownership="The Walt Disney Company"),
    "CoinDesk":          dict(country="United States",  bias="center",        reliability=74, ownership="Bullish group"),
    "Decrypt":           dict(country="United States",  bias="center",        reliability=72, ownership="Decrypt Media"),
    "Cointelegraph":     dict(country="United States",  bias="center",        reliability=70, ownership="Independent"),
    "Hacker News":       dict(country="United States",  bias="n/a",           reliability=80, ownership="Y Combinator (community)"),
    "Nature":            dict(country="United Kingdom", bias="center",        reliability=94, ownership="Springer Nature"),
    "The Economist":     dict(country="United Kingdom", bias="center",        reliability=88, ownership="The Economist Group"),
    # --- India ---
    "The Hindu":         dict(country="India", bias="center-left", reliability=85, ownership="The Hindu Group"),
    "Times of India":    dict(country="India", bias="center",      reliability=72, ownership="Bennett, Coleman & Co."),
    "NDTV":              dict(country="India", bias="center-left", reliability=80, ownership="Adani Group"),
    "Hindustan Times":   dict(country="India", bias="center",      reliability=79, ownership="HT Media"),
    "The Indian Express":dict(country="India", bias="center",      reliability=85, ownership="Indian Express Group"),
    "Livemint":          dict(country="India", bias="center",      reliability=83, ownership="HT Media"),
    "Economic Times":    dict(country="India", bias="center",      reliability=80, ownership="Bennett, Coleman & Co."),
    "India Today":       dict(country="India", bias="center",      reliability=76, ownership="Living Media India"),
    "Scroll.in":         dict(country="India", bias="center-left", reliability=80, ownership="Scroll Media"),
    "The Print":         dict(country="India", bias="center",      reliability=80, ownership="Printline Media"),
    "News18":            dict(country="India", bias="center",      reliability=74, ownership="Network18 / Reliance"),
}

# Fallback for any outlet we encounter via Google News but don't have rated.
UNKNOWN_PUBLISHER = dict(country="Unknown", bias="n/a", reliability=0, ownership="Unrated")


# --- Curated direct RSS feeds ----------------------------------------------
# (url, publisher, category, scope)   scope: "world" or "india"
FEEDS = [
    # ---- World / general ----
    ("https://feeds.bbci.co.uk/news/world/rss.xml",                       "BBC News",         "World",        "world"),
    ("https://feeds.bbci.co.uk/news/business/rss.xml",                    "BBC News",         "Business",     "world"),
    ("https://feeds.bbci.co.uk/news/technology/rss.xml",                  "BBC News",         "Technology",   "world"),
    ("https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",     "BBC News",         "Science",      "world"),
    ("https://feeds.bbci.co.uk/news/health/rss.xml",                      "BBC News",         "Health",       "world"),
    ("https://www.theguardian.com/world/rss",                             "The Guardian",     "World",        "world"),
    ("https://www.theguardian.com/business/rss",                          "The Guardian",     "Business",     "world"),
    ("https://www.theguardian.com/technology/rss",                        "The Guardian",     "Technology",   "world"),
    ("https://www.theguardian.com/science/rss",                           "The Guardian",     "Science",      "world"),
    ("https://www.theguardian.com/environment/climate-crisis/rss",        "The Guardian",     "Climate",      "world"),
    ("https://www.theguardian.com/football/rss",                          "The Guardian",     "Sports",       "world"),
    ("https://www.aljazeera.com/xml/rss/all.xml",                         "Al Jazeera",       "World",        "world"),
    ("https://feeds.npr.org/1001/rss.xml",                                "NPR",              "World",        "world"),
    ("https://feeds.npr.org/1006/rss.xml",                                "NPR",              "Business",     "world"),
    ("https://rss.dw.com/rdf/rss-en-all",                                 "Deutsche Welle",   "World",        "world"),
    ("https://www.france24.com/en/rss",                                   "France 24",        "World",        "world"),
    ("https://www.cnbc.com/id/100003114/device/rss/rss.html",             "CNBC",             "Business",     "world"),
    ("https://www.cnbc.com/id/10000664/device/rss/rss.html",              "CNBC",             "Economy",      "world"),
    ("https://www.cnbc.com/id/19854910/device/rss/rss.html",              "CNBC",             "Technology",   "world"),
    # ---- Technology / AI / startups ----
    ("https://www.theverge.com/rss/index.xml",                            "The Verge",        "Technology",   "world"),
    ("https://feeds.arstechnica.com/arstechnica/index",                   "Ars Technica",     "Technology",   "world"),
    ("https://techcrunch.com/feed/",                                      "TechCrunch",       "Startups",     "world"),
    ("https://www.wired.com/feed/rss",                                    "Wired",            "Technology",   "world"),
    ("https://hnrss.org/frontpage",                                       "Hacker News",      "Technology",   "world"),
    # ---- Science / space / climate ----
    ("https://www.sciencedaily.com/rss/all.xml",                          "Science Daily",    "Science",      "world"),
    ("https://www.space.com/feeds/all",                                   "Space.com",        "Space",        "world"),
    ("https://www.nature.com/nature.rss",                                 "Nature",           "Science",      "world"),
    # ---- Sports ----
    ("https://www.espn.com/espn/rss/news",                                "ESPN",             "Sports",       "world"),
    # ---- Crypto ----
    ("https://decrypt.co/feed",                                          "Decrypt",          "Cryptocurrency","world"),
    ("https://cointelegraph.com/rss",                                     "Cointelegraph",    "Cryptocurrency","world"),

    # ---- India ----
    ("https://www.thehindu.com/news/national/feeder/default.rss",         "The Hindu",        "Politics",     "india"),
    ("https://www.thehindu.com/business/feeder/default.rss",              "The Hindu",        "Business",     "india"),
    ("https://timesofindia.indiatimes.com/rssfeedstopstories.cms",        "Times of India",   "World",        "india"),
    ("https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms",      "Times of India",   "Politics",     "india"),
    ("https://timesofindia.indiatimes.com/rssfeeds/1898055.cms",          "Times of India",   "Business",     "india"),
    ("https://timesofindia.indiatimes.com/rssfeeds/4719148.cms",          "Times of India",   "Technology",   "india"),
    ("https://timesofindia.indiatimes.com/rssfeeds/4719161.cms",          "Times of India",   "Sports",       "india"),
    ("https://feeds.feedburner.com/ndtvnews-top-stories",                 "NDTV",             "Politics",     "india"),
    ("https://feeds.feedburner.com/ndtvnews-india-news",                  "NDTV",             "Politics",     "india"),
    ("https://feeds.feedburner.com/ndtvprofit-latest",                    "NDTV",             "Business",     "india"),
    ("https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml",   "Hindustan Times",  "Politics",     "india"),
    ("https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml",     "Hindustan Times",  "Business",     "india"),
    ("https://indianexpress.com/section/india/feed/",                     "The Indian Express","Politics",    "india"),
    ("https://indianexpress.com/section/technology/feed/",                "The Indian Express","Technology",  "india"),
    ("https://www.livemint.com/rss/news",                                 "Livemint",         "Business",     "india"),
    ("https://www.livemint.com/rss/markets",                              "Livemint",         "Finance",      "india"),
    ("https://economictimes.indiatimes.com/rssfeedstopstories.cms",       "Economic Times",   "Economy",      "india"),
    ("https://www.indiatoday.in/rss/1206578",                             "India Today",      "Politics",     "india"),
    ("https://feeds.feedburner.com/ScrollinArticles",                     "Scroll.in",        "Politics",     "india"),
    ("https://theprint.in/feed/",                                         "The Print",        "Politics",     "india"),
    ("https://www.news18.com/commonfeeds/v1/eng/rss/india.xml",           "News18",           "Politics",     "india"),
]

# --- All categories the UI exposes -----------------------------------------
CATEGORIES = [
    "Politics", "Business", "Economy", "Finance", "Technology", "AI", "Science",
    "Space", "Climate", "Health", "Sports", "Entertainment", "Education",
    "Crime", "Defence", "Startups", "Cryptocurrency", "Government",
    "Transportation", "Agriculture", "Energy", "World",
]

# Categories without enough direct-feed coverage are filled from Google News.
# Maps category -> search query used to build a Google News RSS request.
CATEGORY_QUERIES = {
    "AI":             "artificial intelligence OR machine learning",
    "Politics":       "politics government election",
    "Economy":        "economy inflation GDP central bank",
    "Finance":        "stock market finance investing",
    "Entertainment":  "entertainment film music celebrity",
    "Education":      "education university schools",
    "Crime":          "crime police investigation",
    "Defence":        "defence military army",
    "Government":     "government policy parliament",
    "Transportation": "transport railway aviation traffic",
    "Agriculture":    "agriculture farming crops",
    "Energy":         "energy oil power renewable",
    "Health":         "health medicine disease",
    "Climate":        "climate change global warming",
    "Space":          "space NASA ISRO rocket launch",
    "Science":        "science research discovery",
    "Startups":       "startup funding venture capital",
    "Cryptocurrency": "cryptocurrency bitcoin ethereum",
    "Sports":         "sports match tournament",
    "Business":       "business company markets",
    "Technology":     "technology gadgets software",
}

# Indian states / UTs for the India tab regional filter.
INDIAN_STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
    "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
    "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram",
    "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
    "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
    "Delhi", "Jammu and Kashmir", "Ladakh", "Puducherry", "Chandigarh",
]

# Major-country list for the world-map panel, with rough query hooks.
MAP_COUNTRIES = [
    "United States", "United Kingdom", "India", "China", "Russia", "Ukraine",
    "Israel", "Palestine", "France", "Germany", "Japan", "Australia", "Canada",
    "Brazil", "Pakistan", "Bangladesh", "Saudi Arabia", "Iran", "Nigeria",
    "South Africa", "Mexico", "Indonesia", "Singapore", "United Arab Emirates",
]
