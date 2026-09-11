// src/index.js
import fs from "fs";
import path from "path";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { Crawler } from "./crawler.js";
import { DEFAULT_CONFIG } from "./config.js";
import { STATES, CITIES, PARTIES } from "./data/places.js";

function loadLines(filePath) {
  try {
    if (!filePath) return [];
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function generateBaseQueries(extra = []) {
  const categories = [
    "canal Telegram política", "grupo Telegram política", "canal Telegram eleições", "grupo Telegram eleições",
    "canal Telegram partidos", "grupo Telegram partidos", "canal Telegram governo", "grupo Telegram governo",
    "canal Telegram Congresso", "canal Telegram Senado", "canal Telegram STF", "canal Telegram TSE",
    "canal Telegram notícias políticas", "grupo Telegram notícias políticas", "canal Telegram opinião política",
    "lista canais telegram política", "lista grupos telegram política", "diretório telegram canais políticos",
    "telegram canais política Brasil", "telegram grupos política Brasil"
  ];
  const queries = new Set();
  for (const c of categories) queries.add(c);
  for (const state of STATES) {
    for (const base of ["canal Telegram política", "grupo Telegram política", "Telegram política"]) {
      queries.add(`${base} ${state}`);
      queries.add(`${base} ${state} Brasil`);
    }
    for (const party of PARTIES) {
      queries.add(`${party} canal Telegram`);
      queries.add(`${party} grupo Telegram`);
    }
  }
  for (const city of CITIES) {
    for (const base of ["canal Telegram política", "grupo Telegram política", "Telegram política"]) {
      queries.add(`${base} ${city}`);
    }
  }
  extra.forEach((e) => queries.add(e));
  return Array.from(queries);
}

function generateSiteTelegramQueries() {
  const bases = ["política", "eleições", "Brasil", "Bolsonaro", "Lula", "Congresso", "Senado", "STF", "TSE"];
  const queries = [];
  for (const b of bases) {
    queries.push(`site:t.me "${b}"`);
    for (const s of STATES) {
      queries.push(`site:t.me "${b}" ${s}`);
    }
    for (const c of CITIES.slice(0,10)) {
      queries.push(`site:t.me "${b}" ${c}`);
    }
  }
  return queries;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option("queries-file", { alias: "q", type: "string" })
    .option("sources-file", { alias: "s", type: "string" })
    .option("max-results", { alias: "m", type: "number", default: DEFAULT_CONFIG.MAX_RESULTS })
    .option("max-depth", { type: "number", default: DEFAULT_CONFIG.MAX_DEPTH })
    .option("request-delay", { type: "number", default: DEFAULT_CONFIG.REQUEST_DELAY })
    .option("concurrency", { type: "number", default: DEFAULT_CONFIG.CONCURRENCY })
    .option("output", { type: "string", default: DEFAULT_CONFIG.OUTPUT_CSV })
    .option("output-json", { type: "string", default: DEFAULT_CONFIG.OUTPUT_JSON })
    .option("site-tme", { type: "boolean", default: true, description: "Habilita buscas site:t.me diretas" })
    .help()
    .argv;

  const extras = loadLines(argv["queries-file"]);
  const seeds = loadLines(argv["sources-file"]);
  const baseQueries = generateBaseQueries(extras);
  const siteQueries = argv["site-tme"] ? generateSiteTelegramQueries() : [];

  const options = {
    ...DEFAULT_CONFIG,
    MAX_RESULTS: argv["max-results"],
    MAX_DEPTH: argv["max-depth"],
    REQUEST_DELAY: argv["request-delay"],
    CONCURRENCY: argv["concurrency"],
    OUTPUT_CSV: argv["output"],
    OUTPUT_JSON: argv["output-json"]
  };

  fs.mkdirSync(path.dirname(options.OUTPUT_CSV), { recursive: true });

  console.log("Iniciando crawler com:");
  console.log("MAX_RESULTS:", options.MAX_RESULTS);
  console.log("MAX_DEPTH:", options.MAX_DEPTH);
  console.log("REQUEST_DELAY:", options.REQUEST_DELAY);
  console.log("CONCURRENCY:", options.CONCURRENCY);
  console.log("Queries base:", baseQueries.length);
  console.log("Site:t.me queries:", siteQueries.length);
  console.log("Seeds fornecidas:", seeds.length);

  const crawler = new Crawler(options);

  const initialSeeds = seeds.slice(0, 100);
  const includeSiteTelegram = !!argv["site-tme"];

  // merge queries, avoid duplicating site:t.me prefix (seedFromSearchQueries now checks)
  const mergedQueries = baseQueries.concat(siteQueries);

  const stats = await crawler.run(mergedQueries, initialSeeds, includeSiteTelegram);

  console.log("---- RESULTADO ----");
  console.log(`Páginas visitadas: ${stats.pagesVisited}`);
  console.log(`Páginas com links Telegram: ${stats.pagesWithTelegramLinks}`);
  console.log(`Links Telegram encontrados (raw): ${stats.telegramLinksFound}`);
  console.log(`Resultados únicos: ${stats.resultsUnique}`);
  console.log(`Resultados com nome: ${stats.resultsWithName}`);
  console.log(`Resultados com descrição: ${stats.resultsWithDescription}`);
  console.log(`Resultados classificados: ${stats.resultsClassified}`);
  console.log(`Tempo total (s): ${stats.totalTimeSeconds.toFixed(1)}`);
  console.log(`CSV: ${options.OUTPUT_CSV}`);
  console.log(`JSON: ${options.OUTPUT_JSON}`);
  console.log(`STATE: ${options.STATE_FILE || 'output/state.json'}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("index.js")) {
  main().catch((err) => {
    console.error("Erro:", err);
    process.exit(1);
  });
}
