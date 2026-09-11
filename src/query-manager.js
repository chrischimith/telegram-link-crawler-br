// src/query-manager.js

/**
 * Gerencia queries de forma dinâmica e inteligente.
 * - Evita repetição de queries
 * - Expande dinamicamente baseado em resultados
 * - Controla quantidade de novas queries por resultado
 */
export class QueryManager {
  constructor() {
    this.executedQueries = new Set(); // queries já executadas
    this.pendingQueries = new Set();  // queries aguardando execução
    this.queryMetadata = new Map();   // query -> { source, count, timestamp }
  }

  addQuery(query) {
    const normalized = this.normalize(query);
    if (this.executedQueries.has(normalized) || this.pendingQueries.has(normalized)) {
      return false;
    }
    this.pendingQueries.add(normalized);
    return true;
  }

  addQueries(queries) {
    let count = 0;
    for (const q of queries) {
      if (this.addQuery(q)) count++;
    }
    return count;
  }

  markExecuted(query) {
    const normalized = this.normalize(query);
    this.pendingQueries.delete(normalized);
    this.executedQueries.add(normalized);
    return true;
  }

  hasPending() {
    return this.pendingQueries.size > 0;
  }

  getPending() {
    return Array.from(this.pendingQueries);
  }

  getFirst() {
    if (this.pendingQueries.size === 0) return null;
    const q = this.pendingQueries.values().next().value;
    return q;
  }

  count() {
    return { pending: this.pendingQueries.size, executed: this.executedQueries.size };
  }

  normalize(query) {
    return String(query || "").trim().toLowerCase();
  }

  extractTermsFromText(text, maxTerms = 5) {
    if (!text) return [];
    const normalized = text.toLowerCase().trim();
    const words = normalized.split(/\s+/).filter((w) => w.length > 3 && !this.isStopword(w));
    return words.slice(0, maxTerms);
  }

  isStopword(word) {
    const stopwords = new Set([
      "que", "para", "com", "uma", "um", "sem", "por", "foi", "ser", "são",
      "esta", "está", "este", "esse", "esse", "ele", "ela", "seu", "sua",
      "and", "the", "a", "an", "in", "on", "at", "of", "to", "is", "it"
    ]);
    return stopwords.has(word.toLowerCase());
  }

  generateFromMetadata(nome, descricao, estado, cidade, maxNew = 4) {
    const queries = new Set();
    const tokens = [
      ...(nome ? this.extractTermsFromText(nome, 3) : []),
      ...(descricao ? this.extractTermsFromText(descricao, 2) : []),
    ];
    const fullName = (nome || "").trim();
    const shortName = tokens.slice(0, 2).join(" ");

    if (fullName.length >= 6) {
      queries.add(`"${fullName}" Telegram`);
      queries.add(`"${fullName}" site:t.me`);
    }
    if (shortName.length >= 4 && shortName !== fullName) {
      queries.add(`${shortName} Telegram`);
    }
    if (estado && queries.size < maxNew) {
      queries.add(`Telegram ${estado} política`);
    }
    if (cidade && queries.size < maxNew) {
      queries.add(`Telegram ${cidade}`);
    }

    return Array.from(queries).slice(0, maxNew);
  }

  /**
   * Gera queries dinâmicas a partir de termos encontrados em títulos/descrições.
   * Ex: "Política Paraná" -> "canal Telegram Paraná", "grupo Telegram Paraná", "Telegram Paraná"
   */
  generateFromDiscoveredTerms(terms, maxNew = 3) {
    const queries = new Set();
    for (const term of terms) {
      if (!term || term.length < 3) continue;
      // evitar termos genéricos demais
      if (["telegram", "canal", "grupo"].includes(term.toLowerCase())) continue;

      queries.add(`Telegram ${term}`);
      queries.add(`canal Telegram ${term}`);
      queries.add(`grupo Telegram ${term}`);

      if (queries.size >= maxNew) break;
    }
    return Array.from(queries).slice(0, maxNew);
  }

  reset() {
    this.executedQueries.clear();
    this.pendingQueries.clear();
    this.queryMetadata.clear();
  }

  getSummary() {
    return {
      executed: this.executedQueries.size,
      pending: this.pendingQueries.size,
      total: this.executedQueries.size + this.pendingQueries.size
    };
  }
}
