const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function chunkText(text, chunkSize = 800, overlap = 100) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize - overlap;
  }
  return chunks;
}

async function createEmbeddings(chunks) {
  try {
    const BATCH_SIZE = 10;
    const embeddedChunks = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);

      const responses = await Promise.all(
        batch.map((chunk) =>
          client.embeddings.create({ 
            model: "text-embedding-3-small", input: chunk 
          })
        )
      );

      responses.forEach((res, index) => {
        embeddedChunks.push({
          text: batch[index],
          embedding: Array.from(res.data[0].embedding),
        });
      });

      console.log(`Embedded batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(chunks.length / BATCH_SIZE)}`);
    }

    return embeddedChunks;
  } catch (err) {
    console.error("Embedding error:", err.message);
    throw err;
  }
}

function cosineSimilarity(a, b) {
  const va = Array.isArray(a) ? a : Array.from(Object.values(a));
  const vb = Array.isArray(b) ? b : Array.from(Object.values(b));

  if (!va.length || !vb.length || va.length !== vb.length) {
    console.warn(`Cosine similarity dimension mismatch: ${va.length} vs ${vb.length}`);
    return 0;
  }

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < va.length; i++) {
    dot   += va[i] * vb[i];
    normA += va[i] * va[i];
    normB += vb[i] * vb[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function retrieveRelevant(query, storedChunks, topK = 5) {
  if (!storedChunks || storedChunks.length === 0) {
    throw new Error("No stored chunks available for retrieval.");
  }

  const plainChunks = storedChunks.map((chunk) => {
    const obj = chunk.toObject ? chunk.toObject() : chunk;
    return {
      text: obj.text,
      embedding: Array.isArray(obj.embedding)
        ? obj.embedding
        : Array.from(Object.values(obj.embedding)), 
    };
  });

  const validChunks = plainChunks.filter((c) => c.embedding && c.embedding.length > 0);
  if (validChunks.length === 0) {
    throw new Error("All stored chunks have empty embeddings. Re-upload the file.");
  }

  console.log(`🔍 Retrieving from ${validChunks.length} valid chunks for query: "${query.slice(0, 60)}..."`);

  const res = await client.embeddings.create({ model: "text-embedding-3-small", input: query });
  const queryEmbedding = Array.from(res.data[0].embedding);

  const scored = validChunks.map((chunk) => ({
    text:  chunk.text,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  const topChunks = scored.slice(0, topK);
  console.log(`📌 Top chunk scores: ${topChunks.map((c) => c.score.toFixed(3)).join(", ")}`);

  return topChunks.map((c) => c.text).join("\n\n");
}

module.exports = { chunkText, createEmbeddings, retrieveRelevant };