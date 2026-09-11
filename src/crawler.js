// src/crawler.js
import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { createObjectCsvWriter } from "csv-writer";
import PQueue from "p-queue";
import { DEFAULT_CONFIG } from "./config.js";
import { STATES, CITIES } from "./data/places.js";

function safeSleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    url.searchParams.delete("utm_source");
    url.searchParams.delete("utm_medium");
    url.searchParams.delete("utm_campaign");
    return url.toString();
  } catch { return null; }
}

function isValidTelegramUsername(u) {
  return /^[A-Za-z0-9_]{5,32}$/.test(u);
}

function isPrivateOrInvitePath(str) {
  if (!str) return false;
  const p = str.replace(/^\/+/, "").split("/")[0];
  return /^(joinchat|\+|s|login|signup|addchannel)$/i.test(p);
}

function extractTelegramUsernamesFromUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/(?:^|\.)t\.me$/.test(u.hostname) && !/(?:^|\.)telegram\.me$/.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    const first = parts[0];
    if (isPrivateOrInvitePath(first)) return null;
    if (isValidTelegramUsername(first)) return first;
    return null;
  } catch {
    const m = raw.match(/https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([^\/\?\#]+)/i);
    if (m && m[1] && isValidTelegramUsername(m[1])) return m[1];
    return null;
  }
}

const TELEGRAM_LINK_RE_GLOBAL = /https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_+][A-Za-z0-9_+\/\-]{3,})/ig;

export class Crawler {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.results = new Map(); // username -> record
    this.visited = new Set(); // normalized page urls
    this.seenQueueKeys = new Set(); // url|depth
    this.queue = []; // items {url, depth, source, score}
    this.fetchCache = new Map(); // url -> html
    this.metaCache = new Map(); // username -> metadata or null
    this.csvPath = this.config.OUTPUT_CSV;
    this.jsonPath = this.config.OUTPUT_JSON;
    this.statePath = this.config.STATE_FILE;
    this.newSinceSave = 0;
    // statistics
    this.stats = {
      pagesVisited: 0,
      pagesWithTelegramLinks: 0,
      telegramLinksFound: 0,
      resultsWithName: 0,
      resultsWithDescription: 0,
      resultsClassified: 0,
      startTime: new Date()
    };
    fs.mkdirSync(this.config.OUTPUT_DIR, { recursive: true });
    this.csvWriter = createObjectCsvWriter({
      path: this.csvPath,
      header: [
        { id: "nome", title: "nome" },
        { id: "username", title: "username" },
        { id: "telegram_url", title: "telegram_url" },
        { id: "tipo", title: "tipo" },
        { id: "descricao", title: "descricao" },
        { id: "categoria", title: "categoria" },
        { id: "estado", title: "estado" },
        { id: "cidade", title: "cidade" },
        { id: "fonte", title: "fonte" },
        { id: "data_coleta", title: "data_coleta" }
      ]
    });
    this.loadState();
    this.queueExecutor = new PQueue({ concurrency: Math.max(1, this.config.CONCURRENCY) });
  }

  log(tag, ...args) {
    const time = new Date().toISOString();
    console.log(`[${tag}] ${time} -`, ...args);
  }

  loadState() {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = fs.readFileSync(this.statePath, "utf8");
      const st = JSON.parse(raw);
      if (st.results) {
        st.results.forEach((r) => { if (r && r.username) this.results.set(r.username, r); });
      }
      if (st.visited) st.visited.forEach((v) => this.visited.add(v));
      if (st.queue) {
        st.queue.forEach((q) => {
          const key = `${q.url}|${q.depth}`;
          if (!this.seenQueueKeys.has(key)) {
            this.queue.push(q);
            this.seenQueueKeys.add(key);
          }
        });
      }
      if (st.metaCache) {
        Object.entries(st.metaCache).forEach(([k, v]) => this.metaCache.set(k, v));
      }
      this.log("STATE", "carregado", { results: this.results.size, visited: this.visited.size, queue: this.queue.length, metaCache: this.metaCache.size });
    } catch (err) {
      this.log("STATE", "falha ao carregar state:", err.message);
    }
  }

  persistState() {
    try {
      const st = {
        updated_at: new Date().toISOString(),
        results: Array.from(this.results.values()),
        visited: Array.from(this.visited),
        queue: this.queue.slice(0, 5000),
        metaCache: Object.fromEntries(this.metaCache)
      };
      fs.writeFileSync(this.statePath, JSON.stringify(st, null, 2), "utf8");
      this.log("STATE", "state salvo");
    } catch (err) {
      this.log("STATE", "falha ao salvar state:", err.message);
    }
  }

  async saveIfNeeded(force = false) {
    if (force || this.newSinceSave >= this.config.SAVE_INTERVAL) {
      const arr = Array.from(this.results.values());
      try {
        fs.writeFileSync(this.jsonPath, JSON.stringify(arr, null, 2), "utf8");
        await this.csvWriter.writeRecords(arr); // rewrites file, header included
        this.persistState();
        this.log("SAVE", `${arr.length} resultados salvos (JSON + CSV)`);
      } catch (err) {
        this.log("SAVE", "erro salvando resultados:", err.message);
      }
      this.newSinceSave = 0;
    }
  }

  addToQueue(url, depth = 0, source = null, score = 0) {
    const norm = normalizeUrl(url) || url;
    const key = `${norm}|${depth}`;
    if (this.seenQueueKeys.has(key)) return false;
    this.seenQueueKeys.add(key);
    this.queue.push({ url: norm, depth, source, score });
    return true;
  }

  popQueue() {
    if (!this.queue.length) return null;
    this.queue.sort((a, b) => b.score - a.score);
    return this.queue.shift();
  }

  scoreUrlForTelegram(url, source = "") {
    const u = String(url).toLowerCase();
    let score = 0;
    const tokensHigh = ["telegram", "t.me", "canal", "canais", "grupo", "grupos", "channels", "groups", "lista", "directory"];
    for (const t of tokensHigh) if (u.includes(t)) score += 25;
    const knownDirs = ["telegramchannels.me", "telegramgroup", "tgstat", "telegramic", "telegramchannels.org", "tlgrm"];
    for (const kd of knownDirs) if (u.includes(kd)) score += 40;
    const newsTokens = ["noticia", "notícias", "news", "blog", "portal", "jornal"];
    for (const t of newsTokens) if (u.includes(t)) score += 8;
    if (/\.(jpg|jpeg|png|gif|pdf|zip|rar|mp4|mp3|ico)$/i.test(u)) score -= 100;
    if (String(source).toLowerCase().includes("bing:") && String(source).toLowerCase().includes("telegram")) score += 15;
    score = Math.max(0, Math.min(100, score));
    return score;
  }

  async fetchUrl(url, attempt = 0) {
    if (this.fetchCache.has(url)) return this.fetchCache.get(url);
    try {
      const res = await axios.get(url, {
        timeout: this.config.REQUEST_TIMEOUT,
        headers: { "User-Agent": this.config.USER_AGENT },
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400
      });
      const html = res.data;
      this.fetchCache.set(url, html);
      return html;
    } catch (err) {
      if (attempt < this.config.RETRIES) {
        await safeSleep(1000 * (attempt + 1));
        return this.fetchUrl(url, attempt + 1);
      }
      this.log("FETCH", `falha ${url}: ${err.message}`);
      return null;
    }
  }

  extractLinksFromHtml(html, baseUrl) {
    const $ = cheerio.load(html);
    const anchors = [];
    $("a[href]").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      try {
        const u = new URL(href, baseUrl).toString();
        anchors.push(u);
      } catch {}
    });
    return anchors;
  }

  findTelegramLinksInHtml(html, sourceUrl) {
    const found = new Map();
    if (!html) return [];
    const $ = cheerio.load(html);
    $("a[href]").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      let full;
      try { full = new URL(href, sourceUrl).toString(); } catch { full = href; }
      const username = extractTelegramUsernamesFromUrl(full);
      if (username) {
        if (!found.has(username)) found.set(username, { username, sources: new Set(), contexts: new Set() });
        found.get(username).sources.add(sourceUrl);
        found.get(username).contexts.add($(el).text().trim().slice(0, 200));
      }
    });
    const text = $.text();
    let m;
    TELEGRAM_LINK_RE_GLOBAL.lastIndex = 0;
    while ((m = TELEGRAM_LINK_RE_GLOBAL.exec(text))) {
      const raw = m[0];
      const maybe = extractTelegramUsernamesFromUrl(raw);
      if (maybe) {
        if (!found.has(maybe)) found.set(maybe, { username: maybe, sources: new Set(), contexts: new Set() });
        found.get(maybe).sources.add(sourceUrl);
        found.get(maybe).contexts.add(raw);
      }
    }
    return Array.from(found.values()).map((v) => ({ username: v.username, fonte: Array.from(v.sources)[0], context: Array.from(v.contexts).join(" | ") }));
  }

  isLikelyHtml(url) {
    const nonHtmlExt = [".jpg", ".jpeg", ".png", ".gif", ".pdf", ".zip", ".rar", ".7z", ".gz", ".mp4", ".mp3", ".ogg", ".wav", ".ico", ".css", ".js"];
    const lower = String(url).split("?")[0].toLowerCase();
    for (const e of nonHtmlExt) if (lower.endsWith(e)) return false;
    return true;
  }

  async fetchTelegramMetadata(username) {
    if (!username) return null;
    if (this.metaCache.has(username)) return this.metaCache.get(username);
    const url = `https://t.me/${username}`;
    const html = await this.fetchUrl(url);
    if (!html) {
      this.metaCache.set(username, null);
      return null;
    }
    try {
      const $ = cheerio.load(html);
      const name = ($(".tgme_page_title").first().text() || $('meta[property="og:title"]').attr("content") || $("title").text() || "").trim();
      const description = ($(".tgme_page_description").first().text() || $('meta[property="og:description"]').attr("content") || "").trim();
      let tipo = "";
      const bodyText = $("body").text().toLowerCase();
      if (bodyText.includes("canal") || bodyText.includes("channel")) tipo = "canal";
      if (bodyText.includes("grupo") || bodyText.includes("group")) tipo = tipo ? `${tipo};grupo` : "grupo";
      const extra = $(".tgme_page_extra").first().text().trim() || "";
      const meta = { nome: name || "", descricao: description || extra || "", tipo: tipo || "", fetched_at: new Date().toISOString() };
      this.metaCache.set(username, meta);
      return meta;
    } catch (err) {
      this.metaCache.set(username, null);
      return null;
    }
  }

  classify({ nome = "", descricao = "", fonte = "" }) {
    const text = `${nome} ${descricao} ${fonte}`.toLowerCase();
    const mapping = [
      { keys: ["eleição", "eleicoes", "voto", "candidato", "eleitoral", "eleições"], cat: "eleições" },
      { keys: ["partido", "pt ", "psdb", "psol", "mdb", "pl ", "psd "], cat: "partido" },
      { keys: ["governador", "governo estadual", "estado"], cat: "política estadual" },
      { keys: ["prefeito", "prefeitura", "municipal", "vereador"], cat: "política municipal" },
      { keys: ["congresso", "deputado", "câmara", "camara"], cat: "congresso" },
      { keys: ["senado"], cat: "senado" },
      { keys: ["stf", "supremo tribunal"], cat: "STF" },
      { keys: ["tse", "tribunal superior eleitoral"], cat: "TSE" },
      { keys: ["direita", "conservador"], cat: "direita" },
      { keys: ["esquerda", "progressista"], cat: "esquerda" },
      { keys: ["centro", "centrista"], cat: "centro" },
      { keys: ["notícia", "noticia", "news", "portal", "jornal"], cat: "notícias políticas" },
      { keys: ["opinião", "opiniao", "coluna", "editorial"], cat: "opinião política" },
      { keys: ["movimento", "ativismo"], cat: "movimentos políticos" }
    ];
    for (const m of mapping) {
      for (const k of m.keys) if (text.includes(k)) return m.cat;
    }
    return "";
  }

  findStateCity({ nome = "", descricao = "", fonte = "" }) {
    const text = `${nome} ${descricao} ${fonte}`.toLowerCase();
    let foundState = "";
    let foundCity = "";
    for (const s of STATES) if (text.includes(s.toLowerCase())) { foundState = s; break; }
    for (const c of CITIES) if (text.includes(c.toLowerCase())) { foundCity = c; break; }
    return { estado: foundState, cidade: foundCity };
  }

  addResult(record) {
    const username = record.username;
    if (!username || !isValidTelegramUsername(username)) return false;
    if (this.results.has(username)) return false;
    const out = {
      nome: record.nome || "",
      username,
      telegram_url: `https://t.me/${username}`,
      tipo: record.tipo || "",
      descricao: record.descricao || "",
      categoria: record.categoria || "",
      estado: record.estado || "",
      cidade: record.cidade || "",
      fonte: record.fonte || "",
      data_coleta: new Date().toISOString()
    };
    this.results.set(username, out);
    if (out.nome) this.stats.resultsWithName += 1;
    if (out.descricao) this.stats.resultsWithDescription += 1;
    if (out.categoria) this.stats.resultsClassified += 1;
    this.newSinceSave += 1;
    return true;
  }

  async seedFromSearchQueries(queries, includeSiteTelegram = false) {
    // includeSiteTelegram: if true, prefix queries without existing site: with site:t.me
    for (const qOrig of queries) {
      if (this.results.size >= this.config.MAX_RESULTS) {
        this.log("LIMIT", `MAX_RESULTS atingido: ${this.config.MAX_RESULTS}`);
        return;
      }
      const lower = String(qOrig).toLowerCase();
      const qFinal = includeSiteTelegram && !lower.includes("site:t.me") ? `site:t.me ${qOrig}` : qOrig;
      for (let p = 0; p < this.config.BING_SEARCH_PAGES; p++) {
        if (this.results.size >= this.config.MAX_RESULTS) {
          this.log("LIMIT", `MAX_RESULTS atingido: ${this.config.MAX_RESULTS}`);
          return;
        }
        const first = p * 10 + 1;
        const url = `https://www.bing.com/search?q=${encodeURIComponent(qFinal)}&first=${first}`;
        this.log("SEARCH", qFinal);
        const html = await this.fetchUrl(url);
        if (!html) continue;
        const $ = cheerio.load(html);
        // immediate: find any direct t.me links embedded in search result snippets
        const directTme = this.findTelegramLinksInHtml(html, url);
        for (const t of directTme) {
          if (this.results.size >= this.config.MAX_RESULTS) break;
          this.stats.telegramLinksFound += 1;
          this.log("TELEGRAM", `@${t.username} (direct from search: ${qFinal})`);
          if (!isValidTelegramUsername(t.username)) continue;
          const meta = await this.fetchTelegramMetadata(t.username);
          const categoria = this.classify({ nome: meta?.nome || "", descricao: meta?.descricao || "", fonte: t.fonte || url });
          const { estado, cidade } = this.findStateCity({ nome: meta?.nome || "", descricao: meta?.descricao || "", fonte: t.fonte || url });
          const rec = {
            username: t.username,
            nome: meta?.nome || "",
            descricao: meta?.descricao || "",
            tipo: meta?.tipo || "",
            categoria: categoria || "",
            estado: estado || "",
            cidade: cidade || "",
            fonte: t.fonte || url
          };
          const added = this.addResult(rec);
          if (added) await this.saveIfNeeded();
          if (this.results.size >= this.config.MAX_RESULTS) {
            this.log("LIMIT", `MAX_RESULTS atingido: ${this.config.MAX_RESULTS}`);
            return;
          }
        }
        // Enqueue search result links (but only relevant ones)
        $("li.b_algo h2 a").each((i, el) => {
          const href = $(el).attr("href");
          if (href) {
            const score = this.scoreUrlForTelegram(href, `bing:${qFinal}`);
            this.addToQueue(href, 0, `bing:${qFinal}`, score);
          }
        });
        $("a[href]").each((i, el) => {
          const href = $(el).attr("href");
          if (!href) return;
          try {
            const full = new URL(href, url).toString();
            if (!full.includes("bing.com")) {
              const score = this.scoreUrlForTelegram(full, `bing:${qFinal}`);
              this.addToQueue(full, 0, `bing:${qFinal}`, score);
            }
          } catch {}
        });
        await safeSleep(this.config.REQUEST_DELAY);
      }
    }
  }

  isSourceLikelyTelegramDirectory(url) {
    const low = String(url).toLowerCase();
    const dirIndicators = ["telegramchannels", "telegramgroup", "tgstat", "telegramic", "lista", "canais", "grupos", "telegramchannels.me", "tlgrm"];
    for (const d of dirIndicators) if (low.includes(d)) return true;
    return false;
  }

  anchorIsRelevant(a) {
    if (!a || !this.isLikelyHtml(a)) return false;
    const low = String(a).toLowerCase();
    // priority whitelist tokens (telegram related, directories, or explicit channel/group indicators)
    const high = ["t.me", "telegram.me", "telegramchannels", "telegramgroup", "tgstat", "tlgrm", "telegramic", "canais", "canal", "grupo", "grupos", "channels", "groups"];
    for (const h of high) if (low.includes(h)) return true;
    // news/politics only if path or query contains political tokens
    const politicalTokens = ["política", "politica", "eleição", "eleicoes", "eleições", "eleição", "eleicoes", "eleicoes", "eleja", "partido", "governo", "senado", "congresso", "prefeito", "vereador", "governador", "noticia", "notícias", "jornal", "opinião", "opiniao"];
    for (const t of politicalTokens) {
      if (low.includes(t)) return true;
    }
    // otherwise do not accept generic domains simply because they end with .com/.br/.org
    return false;
  }

  generateQueriesFromMetadata(nome, descricao, maxNew = 4) {
    const full = `${nome}`.trim();
    const short = (nome || descricao || "").trim().split(/\s+/).slice(0,4).join(" ").trim();
    const queries = new Set();
    if (full && full.length >= 6) {
      queries.add(`"${full}" Telegram`);
      queries.add(`"${full}" site:t.me`);
      if (short && short.toLowerCase() !== full.toLowerCase()) {
        queries.add(`"${short}" Telegram`);
      }
    } else if (short && short.length >= 4) {
      queries.add(`"${short}" Telegram`);
      queries.add(`"${short}" site:t.me`);
    }
    const text = `${nome} ${descricao}`.toLowerCase();
    for (const s of STATES) if (text.includes(s.toLowerCase())) queries.add(`Telegram ${s}`);
    for (const c of CITIES) if (text.includes(c.toLowerCase())) queries.add(`Telegram ${c}`);
    return Array.from(queries).slice(0, maxNew);
  }

  async processQueueItem(item) {
    const { url, depth, source } = item;
    if (this.visited.has(url)) return;
    if (this.results.size >= this.config.MAX_RESULTS) return;
    if (!this.isLikelyHtml(url)) { this.visited.add(url); return; }
    this.log("PAGE", url);
    const html = await this.fetchUrl(url);
    this.visited.add(url);
    this.stats.pagesVisited += 1;
    await safeSleep(this.config.REQUEST_DELAY);
    if (!html) return;
    const tlinks = this.findTelegramLinksInHtml(html, url);
    if (tlinks.length > 0) this.stats.pagesWithTelegramLinks += 1;
    for (const t of tlinks) {
      this.stats.telegramLinksFound += 1;
      this.log("TELEGRAM", `@${t.username} (fonte: ${t.fonte})`);
      if (!isValidTelegramUsername(t.username)) continue;
      const meta = await this.fetchTelegramMetadata(t.username);
      if (meta) this.log("META", `@${t.username} nome="${meta.nome}" desc="${meta.descricao ? meta.descricao.slice(0,80) : ""}"`);
      const categoria = this.classify({ nome: meta?.nome || "", descricao: meta?.descricao || "", fonte: t.fonte || url });
      const { estado, cidade } = this.findStateCity({ nome: meta?.nome || "", descricao: meta?.descricao || "", fonte: t.fonte || url });
      const rec = {
        username: t.username,
        nome: meta?.nome || "",
        descricao: meta?.descricao || t.context || "",
        tipo: meta?.tipo || "",
        categoria: categoria || "",
        estado: estado || "",
        cidade: cidade || "",
        fonte: t.fonte || url
      };
      const added = this.addResult(rec);
      if (added) await this.saveIfNeeded();
      if (this.results.size >= this.config.MAX_RESULTS) {
        this.log("LIMIT", `MAX_RESULTS atingido: ${this.config.MAX_RESULTS}`);
        return;
      }
      if (meta && (meta.nome || meta.descricao)) {
        const newQueries = this.generateQueriesFromMetadata(meta.nome, meta.descricao, 3);
        for (const nq of newQueries) {
          this.log("DISCOVER", `gerada query a partir de @${t.username}: "${nq}"`);
          const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(nq)}`;
          const score = 70;
          this.addToQueue(searchUrl, 0, `derived:${t.username}`, score);
        }
      }
    }
    if (this.results.size >= this.config.MAX_RESULTS) return;
    if (depth + 1 <= this.config.MAX_DEPTH) {
      const anchors = this.extractLinksFromHtml(html, url);
      const tCount = tlinks.length;
      for (const a of anchors) {
        if (!a) continue;
        if (a.startsWith("mailto:") || a.startsWith("javascript:")) continue;
        try {
          const host = new URL(a).hostname || "";
          if (/t\.me$/.test(host) || /telegram\.me$/.test(host)) continue;
        } catch {}
        if (!this.anchorIsRelevant(a)) continue;
        const baseScore = this.scoreUrlForTelegram(a, source || url);
        const score = baseScore + Math.min(50, tCount * 10);
        this.addToQueue(a, depth + 1, url, score);
      }
    }
  }

  async run(initialQueries = [], initialSeeds = [], includeSiteTelegram = false) {
    initialSeeds.forEach((s) => {
      const score = this.scoreUrlForTelegram(s, "seed");
      this.addToQueue(s, 0, "seed", score);
    });
    await this.seedFromSearchQueries(initialQueries, includeSiteTelegram);
    this.log("RUN", `fila inicial: ${this.queue.length} itens`);
    while ((this.queue.length > 0 || this.queueExecutor.pending > 0) && this.results.size < this.config.MAX_RESULTS) {
      while (this.queue.length > 0 && this.queueExecutor.size + this.queueExecutor.pending < Math.max(2, this.config.CONCURRENCY * 2)) {
        const item = this.popQueue();
        if (!item) break;
        if (this.visited.has(item.url)) continue;
        this.queueExecutor.add(() => this.processQueueItem(item)).catch((e) => { this.log("QUEUE", "erro item:", e.message); });
      }
      await safeSleep(300);
      await this.saveIfNeeded();
    }
    await this.queueExecutor.onIdle();
    await this.saveIfNeeded(true);
    const totalTime = (new Date() - this.stats.startTime) / 1000;
    return {
      pagesVisited: this.stats.pagesVisited,
      pagesWithTelegramLinks: this.stats.pagesWithTelegramLinks,
      telegramLinksFound: this.stats.telegramLinksFound,
      resultsUnique: this.results.size,
      resultsWithName: this.stats.resultsWithName,
      resultsWithDescription: this.stats.resultsWithDescription,
      resultsClassified: this.stats.resultsClassified,
      totalTimeSeconds: totalTime
    };
  }
}
