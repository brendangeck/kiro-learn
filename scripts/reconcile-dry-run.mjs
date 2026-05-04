#!/usr/bin/env node
/**
 * scripts/reconcile-dry-run.mjs
 *
 * Threshold calibration aid for the reconciliation engine.
 *
 * Originally used as an implementation-time checkpoint (Task 9.5 of the
 * reconciliation-engine spec) to surface likely merge pairs before the
 * reconciler was wired into the ingestion pipeline. Retained as a utility
 * for operators who want to explore how different intra-batch and
 * neighbor-similarity thresholds would affect their live graph WITHOUT
 * actually invoking the judge or committing writes.
 *
 * The script opens the user's `~/.kiro-learn/kiro-learn.db` in read-only
 * mode, computes the intra-batch clustering for each namespace using the
 * provided thresholds, and prints each cluster that would trigger a
 * neighbor lookup at the given threshold. It does NOT invoke the
 * kiro-learn-reconciler judge, and it performs zero writes.
 *
 * ## Usage
 *
 *   node scripts/reconcile-dry-run.mjs
 *   node scripts/reconcile-dry-run.mjs --intra-batch 0.90 --neighbor 0.85
 *
 * ## Flags
 *
 *   --intra-batch <x>   Cosine threshold for intra-batch clustering. Default 0.85.
 *   --neighbor <x>      Cosine threshold for neighbor lookup.      Default 0.80.
 *
 * Both flags validate `x ∈ [0, 1]` and reject with exit code 1 otherwise.
 *
 * ## Notes
 *
 * - The clustering algorithm here is an intentional duplicate of the
 *   canonical TypeScript implementation in `src/collector/ingestion/clustering.ts`.
 *   Duplication is preferred over importing from `dist/` so the script has
 *   no build prerequisite — it runs against a fresh checkout. Any behavior
 *   change to the canonical implementation should be mirrored here.
 * - The DB is opened read-only with `fileMustExist: true`; running against a
 *   nonexistent DB is treated as "nothing to calibrate" and exits 0.
 * - Output is similarity-only. The real pipeline additionally filters via
 *   the judge, so this script is expected to surface false positives
 *   relative to what the reconciler would actually merge.
 *
 * ## Manual verification checklist
 *
 *   1. Run: node scripts/reconcile-dry-run.mjs
 *   2. Eyeball the merge candidates surfaced per cluster — are the pairs
 *      actually duplicates?
 *   3. Optionally sweep thresholds:
 *        node scripts/reconcile-dry-run.mjs --intra-batch 0.90 --neighbor 0.85
 *   4. If defaults look wrong, adjust `intraBatchSimilarityThreshold` and
 *      `neighborSimilarityThreshold` in `src/collector/ingestion/index.ts`
 *      and `src/collector/index.ts`.
 *   5. If defaults look reasonable, proceed to Task 10 (IngestionPipeline
 *      orchestration).
 *
 * Strongly recommended before Tasks 10 and 13 (collector wiring) — the
 * defaults could over-merge and irrecoverably delete rows. Merges are
 * destructive (no undo).
 */

import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

// ── Constants ──────────────────────────────────────────────────────────────

const EMBEDDING_DIMS = 384;
const EMBEDDING_BLOB_BYTES = EMBEDDING_DIMS * 4;
const NEIGHBOR_POOL_CAP = 10;

const DEFAULT_INTRA_BATCH = 0.85;
const DEFAULT_NEIGHBOR = 0.8;

// ── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let intraBatch = DEFAULT_INTRA_BATCH;
  let neighbor = DEFAULT_NEIGHBOR;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--intra-batch' || flag === '--neighbor') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        fail(`missing value for ${flag}`);
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        fail(
          `invalid value for ${flag}: ${raw} — must be a number in [0, 1]`,
        );
      }
      if (flag === '--intra-batch') {
        intraBatch = value;
      } else {
        neighbor = value;
      }
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      printUsage();
      process.exit(0);
    } else {
      fail(`unknown argument: ${flag}`);
    }
  }

  return { intraBatch, neighbor };
}

function printUsage() {
  process.stdout.write(
    'Usage: node scripts/reconcile-dry-run.mjs [--intra-batch <x>] [--neighbor <x>]\n' +
      '\n' +
      '  --intra-batch <x>   Cosine threshold for intra-batch clustering. Default 0.85.\n' +
      '  --neighbor <x>      Cosine threshold for neighbor lookup.      Default 0.80.\n' +
      '\n' +
      'Both thresholds must be in the closed interval [0, 1].\n',
  );
}

function fail(message) {
  process.stderr.write(`reconcile-dry-run: ${message}\n`);
  process.exit(1);
}

// ── Embedding decode ───────────────────────────────────────────────────────

/**
 * Decode a little-endian 1536-byte BLOB into a fresh Float32Array(384).
 *
 * Mirrors `src/collector/embedding/blob.ts` — explicit DataView reads so the
 * result is correct regardless of host byte order (Node is little-endian on
 * every platform kiro-learn supports today, but the explicit flag keeps
 * future hosts safe).
 */
function decodeEmbedding(blob) {
  if (!Buffer.isBuffer(blob) || blob.length !== EMBEDDING_BLOB_BYTES) {
    return null;
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
    out[i] = view.getFloat32(i * 4, /* littleEndian */ true);
  }
  return out;
}

// ── Cosine + normalize (inlined from src/collector/embedding/cosine.ts) ────

function cosine(a, b) {
  const n = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i += 1) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalize(a) {
  const n = a.length;
  let normSq = 0;
  for (let i = 0; i < n; i += 1) {
    const ai = a[i];
    normSq += ai * ai;
  }
  const out = new Float32Array(n);
  if (normSq === 0) return out;
  const inv = 1 / Math.sqrt(normSq);
  for (let i = 0; i < n; i += 1) {
    out[i] = a[i] * inv;
  }
  return out;
}

// ── Union-find (inlined from src/collector/ingestion/clustering.ts) ────────

/**
 * Partition an array of pseudo-candidates into clusters of near-duplicates.
 *
 * Intentionally duplicates the algorithm in
 * `src/collector/ingestion/clustering.ts`. See the canonical file for the
 * full algorithm doc; in short:
 *
 *   - Disjoint-set forest with path compression + union by rank.
 *   - Null-embedding rows stay singletons (never unioned).
 *   - For every `(i, j)` with non-null embeddings, union if cosine ≥ threshold.
 *   - Clusters are emitted in order of first-appearance index; members ascending.
 *   - Centroid = L2-normalized mean of member embeddings when every member
 *     has a non-null embedding; null otherwise.
 */
function intraBatchCluster(candidates, threshold) {
  const n = candidates.length;
  if (n === 0) return [];

  const parent = new Int32Array(n);
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;

  function find(x) {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let node = x;
    while (parent[node] !== root) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb;
    } else if (rank[ra] > rank[rb]) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra] += 1;
    }
  }

  for (let i = 0; i < n; i += 1) {
    const ei = candidates[i].embedding;
    if (ei === null) continue;
    for (let j = i + 1; j < n; j += 1) {
      const ej = candidates[j].embedding;
      if (ej === null) continue;
      if (cosine(ei, ej) >= threshold) union(i, j);
    }
  }

  const rootToMembers = new Map();
  const rootOrder = [];
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const existing = rootToMembers.get(root);
    if (existing === undefined) {
      rootToMembers.set(root, [i]);
      rootOrder.push(root);
    } else {
      existing.push(i);
    }
  }

  const clusters = [];
  for (const root of rootOrder) {
    const members = rootToMembers.get(root);
    clusters.push({
      members,
      centroid: computeCentroid(members, candidates),
    });
  }
  return clusters;
}

function computeCentroid(members, candidates) {
  if (members.length === 0) return null;
  const first = candidates[members[0]].embedding;
  if (first === null) return null;

  const dims = first.length;
  const sum = new Float64Array(dims);

  for (const idx of members) {
    const e = candidates[idx].embedding;
    if (e === null) return null;
    for (let k = 0; k < dims; k += 1) sum[k] += e[k];
  }

  const mean = new Float32Array(dims);
  const invN = 1 / members.length;
  for (let k = 0; k < dims; k += 1) mean[k] = sum[k] * invN;

  return normalize(mean);
}

// ── DB access ──────────────────────────────────────────────────────────────

function resolveDbPath() {
  return path.join(os.homedir(), '.kiro-learn', 'kiro-learn.db');
}

function listNamespaces(db) {
  const rows = db
    .prepare('SELECT DISTINCT namespace FROM memory_records ORDER BY namespace')
    .all();
  return rows.map((r) => r.namespace);
}

function loadNamespaceRows(db, namespace) {
  const rows = db
    .prepare(
      'SELECT record_id, namespace, strategy, title, summary, ' +
        '       facts_json, source_event_ids_json, created_at, embedding ' +
        '  FROM memory_records ' +
        ' WHERE namespace = ? ' +
        ' ORDER BY created_at, record_id',
    )
    .all(namespace);

  return rows.map((r) => ({
    record_id: r.record_id,
    namespace: r.namespace,
    title: r.title,
    summary: r.summary,
    strategy: r.strategy,
    created_at: r.created_at,
    embedding: decodeEmbedding(r.embedding),
  }));
}

// ── Reporting ──────────────────────────────────────────────────────────────

function formatClusterReport(namespace, rows, clusters, clustersWithNeighbors) {
  const lines = [];
  lines.push(`## namespace: ${namespace}`);
  lines.push('');
  lines.push(`- total records: ${rows.length}`);
  lines.push(`- records with embeddings: ${rows.filter((r) => r.embedding !== null).length}`);
  lines.push(`- clusters formed: ${clusters.length}`);
  lines.push(`- clusters with neighbors: ${clustersWithNeighbors.length}`);
  lines.push('');

  if (clustersWithNeighbors.length === 0) {
    lines.push('_No clusters with neighbors at this threshold._');
    lines.push('');
    return lines.join('\n');
  }

  clustersWithNeighbors.forEach((entry, idx) => {
    const { cluster, neighbors } = entry;
    lines.push(`### cluster ${idx + 1} — ${cluster.members.length} member(s)`);
    lines.push('');
    lines.push('Members:');
    for (const memberIdx of cluster.members) {
      const row = rows[memberIdx];
      lines.push(`  - ${row.record_id}  ${formatTitle(row.title)}`);
    }
    lines.push('');
    lines.push(`Neighbors (similarity ≥ threshold, top ${NEIGHBOR_POOL_CAP}):`);
    for (const n of neighbors) {
      lines.push(
        `  - ${n.record.record_id}  sim=${n.similarity.toFixed(4)}  ${formatTitle(n.record.title)}`,
      );
    }
    lines.push('');
  });

  return lines.join('\n');
}

function formatTitle(title) {
  const s = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= 80) return s;
  return s.slice(0, 77) + '...';
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { intraBatch, neighbor } = parseArgs(process.argv.slice(2));
  const dbPath = resolveDbPath();

  process.stdout.write(
    '# reconcile-dry-run — threshold calibration report\n' +
      '\n' +
      'Read-only similarity-only preview. The real reconciler filters further via the\n' +
      'kiro-learn-reconciler judge, so this output is expected to surface false positives\n' +
      'relative to what would actually be merged. The database is opened read-only and no\n' +
      'writes are performed.\n' +
      '\n' +
      `- db path:               ${dbPath}\n` +
      `- intra-batch threshold: ${intraBatch}\n` +
      `- neighbor threshold:    ${neighbor}\n` +
      `- neighbor pool cap:     ${NEIGHBOR_POOL_CAP}\n` +
      '\n',
  );

  if (!fs.existsSync(dbPath)) {
    process.stdout.write(
      `No kiro-learn database found at ${dbPath}. Nothing to calibrate.\n` +
        'Run the collector for a while to accumulate memory records, then re-run this script.\n',
    );
    process.exit(0);
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    fail(`failed to open database: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const namespaces = listNamespaces(db);
    if (namespaces.length === 0) {
      process.stdout.write('No memory records found in any namespace.\n');
      return;
    }

    for (const namespace of namespaces) {
      const rows = loadNamespaceRows(db, namespace);
      const clusters = intraBatchCluster(rows, intraBatch);

      const clustersWithNeighbors = [];
      for (const cluster of clusters) {
        if (cluster.centroid === null) continue;

        // For each cluster, compute neighbors: rank every row in the same
        // namespace by cosine against the centroid, filter by threshold,
        // exclude cluster members (they're not "neighbors" of themselves),
        // sort desc, cap.
        const memberSet = new Set(cluster.members.map((i) => rows[i].record_id));
        const scored = [];
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          if (row.embedding === null) continue;
          if (memberSet.has(row.record_id)) continue;
          const sim = cosine(cluster.centroid, row.embedding);
          if (sim >= neighbor) {
            scored.push({ record: row, similarity: sim });
          }
        }
        scored.sort((a, b) => b.similarity - a.similarity);
        const topNeighbors = scored.slice(0, NEIGHBOR_POOL_CAP);

        if (topNeighbors.length > 0) {
          clustersWithNeighbors.push({ cluster, neighbors: topNeighbors });
        }
      }

      process.stdout.write(
        formatClusterReport(namespace, rows, clusters, clustersWithNeighbors) + '\n',
      );
    }
  } finally {
    db.close();
  }
}

main();
