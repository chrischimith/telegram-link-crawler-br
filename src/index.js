// src/index.js
import fs from "fs";
import path from "path";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { Crawler } from "./crawler.js";
import { DEFAULT_CONFIG } from "./config.js";

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

/**
 * Queries iniciais otimizadas: poucos termos, alta relevância
 * Expansão será feita dinamicamente baseada em resultados
 */
function getInitialQueries(extra = []) {
  const base = [
    // Política Nacional
    "site:t.me política Brasil Telegram",
    "site:t.me política brasileira Telegram",
    "site:t.me eleições Brasil Telegram",
    "site:t.me notícias políticas Brasil Telegram",
    "site:t.me governo Brasil Telegram",
    
    // Instituições
    "site:t.me Congresso Brasil Telegram",
    "site:t.me Senado Brasil Telegram",
    "site:t.me STF Brasil Telegram",
    "site:t.me TSE Brasil Telegram",
    
    // Ideologia
    "site:t.me partidos políticos Brasil Telegram",
    "site:t.me deputados Brasil Telegram",
    "site:t.me senadores Brasil Telegram",
    
    // Personalidades
    "site:t.me Bolsonaro Telegram",
    "site:t.me Lula Telegram",
    
    // Espectro político
    "site:t.me direita Brasil Telegram",
    "site:t.me esquerda Brasil Telegram"
  ];

  const queries = new Set(base);
  extra.forEach((e) => queries.add(e));
  return Array.from(queries);
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option("queries-file", { alias: "q", type: "string" })
    .option("sources-file", { alias: "s", type: "string" })
    .option("max-results", { alias: "m", type: "number", default: DEFAULT_CONFIG.MAX_RESULTS })
    .option("max-queries", { type: "number", default: DEFAULT_CONFIG.MAX_QUERIES })
    .option("max-depth", { type: "number", default: DEFAULT_CONFIG.MAX_DEPTH })
    .option("request-delay", { type: "number", default: DEFAULT_CONFIG.REQUEST_DELAY })
    .option("concurrency", { type: "number", default: DEFAULT_CONFIG.CONCURRENCY })
    .option("output", { type: "string", default: DEFAULT_CONFIG.OUTPUT_CSV })
    .option("output-json", { type: "string", default: DEFAULT_CONFIG.OUTPUT_JSON })
    .help()
    .argv;

  const extras = loadLines(argv["queries-file"]);
  const seeds = loadLines(argv["sources-file"]);
  const initialQueries = getInitialQueries(extras);

  const options = {
    ...DEFAULT_CONFIG,
    MAX_RESULTS: argv["max-results"],
    MAX_QUERIES: argv["max-queries"],
    MAX_DEPTH: argv["max-depth"],
    REQUEST_DELAY: argv["request-delay"],
    CONCURRENCY: argv["concurrency"],
    OUTPUT_CSV: argv["output"],
    OUTPUT_JSON: argv["output-json"]
  };

  fs.mkdirSync(path.dirname(options.OUTPUT_CSV), { recursive: true });

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║  TELEGRAM LINK CRAWLER - POLÍTICA BRASIL (v2 - DINÂMICO)     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  console.log("Configuração:");
  console.log("  MAX_RESULTS:", options.MAX_RESULTS);
  console.log("  MAX_QUERIES:", options.MAX_QUERIES);
  console.log("  MAX_DEPTH:", options.MAX_DEPTH);
  console.log("  REQUEST_DELAY:", options.REQUEST_DELAY, "ms");
  console.log("  CONCURRENCY:", options.CONCURRENCY);
  console.log("  Queries iniciais:", initialQueries.length);
  console.log("  Seeds URL:", seeds.length);
  console.log("\nEstrutura de Discovery:");
  console.log("  • Queries Iniciais → Busca Bing");
  console.log("  • Resultados → Análise + Geração de Novas Queries");
  console.log("  • Expansão Dinâmica até MAX_RESULTS");
  console.log("  • Limite de Segurança: MAX_QUERIES");
  console.log("  • Parada Automática ao Atingir Limite\n");

  const crawler = new Crawler(options);

  const initialSeeds = seeds.slice(0, 100);

  const stats = await crawler.run(initialQueries, initialSeeds);

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    RESULTADO FINAL                            ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  console.log("Busca:");
  console.log(`  Queries executadas: ${stats.queriesExecuted} / ${stats.maxQueries}`);
  console.log(`  Queries geradas (dinâmicas): ${stats.queriesGenerated}`);
  console.log("\nCrawling:");
  console.log(`  Páginas visitadas: ${stats.pagesVisited}`);
  console.log(`  Páginas com links Telegram: ${stats.pagesWithTelegramLinks}`);
  console.log(`  Links Telegram encontrados (raw): ${stats.telegramLinksFound}`);
  console.log("\nResultados:");
  console.log(`  Resultados únicos: ${stats.resultsUnique} / ${options.MAX_RESULTS}`);
  console.log(`  Com nome: ${stats.resultsWithName}`);
  console.log(`  Com descrição: ${stats.resultsWithDescription}`);
  console.log(`  Classificados: ${stats.resultsClassified}`);
  console.log("\nPerformance:");
  console.log(`  Tempo total: ${stats.totalTimeSeconds.toFixed(1)}s`);
  console.log(`  CSV: ${options.OUTPUT_CSV}`);
  console.log(`  JSON: ${options.OUTPUT_JSON}`);
  console.log(`  STATE: output/state.json\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("index.js")) {
  main().catch((err) => {
    console.error("Erro:", err);
    process.exit(1);
  });
}
