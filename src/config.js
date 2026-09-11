export const DEFAULT_CONFIG = {
  MAX_RESULTS: 1000,
  MAX_DEPTH: 3,
  REQUEST_DELAY: 500, // ms between requests per worker
  CONCURRENCY: 3,
  OUTPUT_DIR: "output",
  OUTPUT_CSV: "output/results.csv",
  OUTPUT_JSON: "output/results.json",
  STATE_FILE: "output/state.json",
  SAVE_INTERVAL: 20, // save after every N new results
  REQUEST_TIMEOUT: 15000, // ms
  RETRIES: 2,
  USER_AGENT:
    "Mozilla/5.0 (compatible; TelegramCrawler/1.0; +https://yourdomain.example/)",
  BING_SEARCH_PAGES: 2 // number of results pages to fetch per query (each ~10 results)
};
