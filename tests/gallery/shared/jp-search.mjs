// A small Japanese full-text index for the gallery's search tools: character bigrams scored with
// BM25. Japanese has no spaces between words, so a word tokenizer needs a dictionary (MeCab,
// Sudachi); overlapping bigrams need none and match 「点検周期」 inside 「定期点検周期は」 well
// enough for a few thousand passages. A production index would add a morphological analyser and
// embeddings; the platform deliberately provides neither (packages/core/src/db/schema/files.ts),
// which is why every search tool in this gallery is your own MCP server built on this file.

const K1 = 1.2;
const B = 0.75;

/** NFKC-normalise (全角英数 → 半角), lower-case, and drop punctuation and spaces. */
export function normalise(value) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}

/** Overlapping character bigrams of each space-separated run; a 1-character run is kept whole. */
export function bigrams(value) {
  const grams = [];
  for (const run of normalise(value).split(' ')) {
    const chars = [...run];
    if (chars.length === 1) grams.push(chars[0]);
    for (let index = 0; index + 1 < chars.length; index += 1) {
      grams.push(chars[index] + chars[index + 1]);
    }
  }
  return grams;
}

function counts(grams) {
  const map = new Map();
  for (const gram of grams) map.set(gram, (map.get(gram) ?? 0) + 1);
  return map;
}

/**
 * Index `passages` (objects with at least `id` and `text`; `title` and `keywords` are indexed too,
 * and every field is returned as-is)
 * and return `search(query, { limit, filter, minCoverage })`, best match first.
 *
 * A passage is returned only when it contains at least `minCoverage` (default a third) of the
 * query's distinct bigrams. Without that floor BM25 scores any overlap, and 「時間」 alone makes
 * 「社員食堂の営業時間」 match a maintenance interval: the agent's honest "not found" answer
 * depends on an unrelated query returning `[]`, not the least-bad passage.
 */
export function createIndex(passages) {
  const documents = passages.map((passage) => {
    const grams = bigrams(`${passage.title ?? ''} ${passage.keywords ?? ''} ${passage.text}`);
    return { passage, length: grams.length, terms: counts(grams) };
  });
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) / Math.max(documents.length, 1);
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const term of document.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = (term) => {
    const frequency = documentFrequency.get(term) ?? 0;
    return Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
  };

  function search(query, { limit = 5, filter = () => true, minCoverage = 1 / 3 } = {}) {
    const queryTerms = [...new Set(bigrams(query))];
    const scored = [];
    for (const document of documents) {
      if (!filter(document.passage)) continue;
      let score = 0;
      let matched = 0;
      for (const term of queryTerms) {
        const frequency = document.terms.get(term);
        if (frequency === undefined) continue;
        matched += 1;
        const norm = frequency + K1 * (1 - B + (B * document.length) / averageLength);
        score += idf(term) * ((frequency * (K1 + 1)) / norm);
      }
      if (matched > 0 && matched / queryTerms.length >= minCoverage) {
        scored.push({ ...document.passage, score: Number(score.toFixed(3)) });
      }
    }
    return scored.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  return { search, size: documents.length };
}
