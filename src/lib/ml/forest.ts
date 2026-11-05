import type { ModelSummary, PredictionResult, Row } from "../types";

// A compact random forest with histogram splits. Dependency-free and serializable.
// Categorical levels are ordered by mean target (or frequency), so each feature stays
// one column and importances map back to the columns people recognise.

export type FeatureKind = "numeric" | "categorical";

export interface FeatureSpec {
  name: string;
  kind: FeatureKind;
}

interface EncodedFeature extends FeatureSpec {
  median: number;
  min?: number;
  max?: number;
  levels?: string[]; // ordered: level i encodes to value i
  thresholds: number[];
}

interface Tree {
  feature: number[]; // -1 marks a leaf
  threshold: number[];
  left: number[];
  right: number[];
  value: (number | number[])[];
}

export interface ForestArtifact {
  task: "regression" | "classification";
  features: EncodedFeature[];
  classes?: string[];
  trees: Tree[];
  residual90?: number; // 90th percentile absolute test error
}

export interface TrainOutput {
  artifact: ForestArtifact;
  summary: Omit<ModelSummary, "id" | "table" | "createdAt">;
}

const OTHER = "(other)";
const BINS = 32;
const TREES = 60;
const MAX_DEPTH = 12;
const MIN_LEAF = 3;
const MAX_LEVELS = 24;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantiles(sorted: number[], count: number): number[] {
  const out = new Set<number>();
  for (let i = 1; i < count; i++) out.add(sorted[Math.floor((i / count) * sorted.length)]);
  return [...out].sort((a, b) => a - b);
}

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
  return Number.isFinite(n) ? n : null;
};

function encodeValue(feature: EncodedFeature, value: unknown): number {
  if (feature.kind === "numeric") return toNumber(value) ?? feature.median;
  const level = value === null || value === undefined ? OTHER : String(value);
  const index = feature.levels!.indexOf(level);
  return index >= 0 ? index : Math.max(0, feature.levels!.indexOf(OTHER));
}

function fitFeature(spec: FeatureSpec, rows: Row[], target: number[], train: number[]): EncodedFeature {
  if (spec.kind === "numeric") {
    const values = train.map((i) => toNumber(rows[i][spec.name])).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)] : 0;
    return { ...spec, median, min: values[0], max: values[values.length - 1], thresholds: quantiles(values, BINS) };
  }
  const stats = new Map<string, { n: number; sum: number }>();
  for (const i of train) {
    const value = rows[i][spec.name];
    const level = value === null || value === undefined ? OTHER : String(value);
    const s = stats.get(level) ?? { n: 0, sum: 0 };
    s.n++;
    s.sum += target[i];
    stats.set(level, s);
  }
  const frequent = [...stats.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, MAX_LEVELS);
  const ordered = frequent.sort((a, b) => a[1].sum / a[1].n - b[1].sum / b[1].n).map(([level]) => level);
  if (!ordered.includes(OTHER)) ordered.push(OTHER);
  return { ...spec, median: 0, levels: ordered, thresholds: ordered.slice(0, -1).map((_, i) => i) };
}

function binOf(thresholds: number[], value: number): number {
  let lo = 0;
  let hi = thresholds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value <= thresholds[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface GrowContext {
  bins: Uint8Array[];
  thresholds: number[][];
  y: Float64Array;
  classes: number; // 0 = regression
  mtry: number;
  random: () => number;
}

function leafValue(ctx: GrowContext, index: Int32Array): number | number[] {
  if (ctx.classes === 0) {
    let sum = 0;
    for (const i of index) sum += ctx.y[i];
    return sum / index.length;
  }
  const counts = new Array<number>(ctx.classes).fill(0);
  for (const i of index) counts[ctx.y[i]]++;
  return counts.map((c) => c / index.length);
}

function bestSplit(ctx: GrowContext, index: Int32Array) {
  const features = ctx.bins.length;
  const chosen = new Set<number>();
  while (chosen.size < Math.min(ctx.mtry, features)) chosen.add(Math.floor(ctx.random() * features));

  let bestGain = 1e-12;
  let bestFeature = -1;
  let bestBin = -1;
  const n = index.length;

  for (const f of chosen) {
    const count = ctx.thresholds[f].length + 1;
    if (count < 2) continue;
    const bin = ctx.bins[f];
    if (ctx.classes === 0) {
      const sums = new Float64Array(count);
      const ns = new Int32Array(count);
      let total = 0;
      for (const i of index) {
        sums[bin[i]] += ctx.y[i];
        ns[bin[i]]++;
        total += ctx.y[i];
      }
      const parent = (total * total) / n;
      let leftSum = 0;
      let leftN = 0;
      for (let b = 0; b < count - 1; b++) {
        leftSum += sums[b];
        leftN += ns[b];
        const rightN = n - leftN;
        if (leftN < MIN_LEAF || rightN < MIN_LEAF) continue;
        const rightSum = total - leftSum;
        const gain = (leftSum * leftSum) / leftN + (rightSum * rightSum) / rightN - parent;
        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = f;
          bestBin = b;
        }
      }
    } else {
      const k = ctx.classes;
      const hist = new Int32Array(count * k);
      const ns = new Int32Array(count);
      const totals = new Int32Array(k);
      for (const i of index) {
        hist[bin[i] * k + ctx.y[i]]++;
        ns[bin[i]]++;
        totals[ctx.y[i]]++;
      }
      let parentSq = 0;
      for (let c = 0; c < k; c++) parentSq += totals[c] * totals[c];
      const parent = parentSq / n;
      const left = new Int32Array(k);
      let leftN = 0;
      for (let b = 0; b < count - 1; b++) {
        leftN += ns[b];
        let leftSq = 0;
        let rightSq = 0;
        for (let c = 0; c < k; c++) {
          left[c] += hist[b * k + c];
          leftSq += left[c] * left[c];
          const right = totals[c] - left[c];
          rightSq += right * right;
        }
        const rightN = n - leftN;
        if (leftN < MIN_LEAF || rightN < MIN_LEAF) continue;
        const gain = leftSq / leftN + rightSq / rightN - parent;
        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = f;
          bestBin = b;
        }
      }
    }
  }
  return { feature: bestFeature, bin: bestBin };
}

function growTree(ctx: GrowContext, sample: Int32Array): Tree {
  const tree: Tree = { feature: [], threshold: [], left: [], right: [], value: [] };
  const stack: { node: number; index: Int32Array; depth: number }[] = [];
  const addNode = () => {
    tree.feature.push(-1);
    tree.threshold.push(0);
    tree.left.push(-1);
    tree.right.push(-1);
    tree.value.push(0);
    return tree.feature.length - 1;
  };
  stack.push({ node: addNode(), index: sample, depth: 0 });
  while (stack.length > 0) {
    const { node, index, depth } = stack.pop()!;
    const split = depth < MAX_DEPTH && index.length >= MIN_LEAF * 2 ? bestSplit(ctx, index) : { feature: -1, bin: -1 };
    if (split.feature < 0) {
      tree.value[node] = leafValue(ctx, index);
      continue;
    }
    const bin = ctx.bins[split.feature];
    let leftCount = 0;
    for (const i of index) if (bin[i] <= split.bin) leftCount++;
    const left = new Int32Array(leftCount);
    const right = new Int32Array(index.length - leftCount);
    let l = 0;
    let r = 0;
    for (const i of index) {
      if (bin[i] <= split.bin) left[l++] = i;
      else right[r++] = i;
    }
    tree.feature[node] = split.feature;
    tree.threshold[node] = ctx.thresholds[split.feature][split.bin];
    tree.left[node] = addNode();
    tree.right[node] = addNode();
    stack.push({ node: tree.left[node], index: left, depth: depth + 1 });
    stack.push({ node: tree.right[node], index: right, depth: depth + 1 });
  }
  return tree;
}

function predictTree(tree: Tree, x: number[]): number | number[] {
  let node = 0;
  while (tree.feature[node] >= 0) {
    node = x[tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node];
  }
  return tree.value[node];
}

function predictEncoded(artifact: ForestArtifact, x: number[]): number[] {
  if (artifact.task === "regression") {
    const values = artifact.trees.map((tree) => predictTree(tree, x) as number);
    return [values.reduce((a, b) => a + b, 0) / values.length];
  }
  const out = new Array<number>(artifact.classes!.length).fill(0);
  for (const tree of artifact.trees) {
    const leaf = predictTree(tree, x) as number[];
    for (let c = 0; c < out.length; c++) out[c] += leaf[c];
  }
  return out.map((v) => v / artifact.trees.length);
}

const argmax = (values: number[]) => values.reduce((best, v, i) => (v > values[best] ? i : best), 0);

function aucBinary(scores: number[], labels: number[]): number {
  const order = scores.map((s, i) => [s, labels[i]] as const).sort((a, b) => a[0] - b[0]);
  let positives = 0;
  let rankSum = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j][0] === order[i][0]) j++;
    const rank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      if (order[k][1] === 1) {
        positives++;
        rankSum += rank;
      }
    }
    i = j;
  }
  const negatives = order.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function macroF1(actual: number[], predicted: number[], classes: number): number {
  let total = 0;
  for (let c = 0; c < classes; c++) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < actual.length; i++) {
      if (predicted[i] === c && actual[i] === c) tp++;
      else if (predicted[i] === c) fp++;
      else if (actual[i] === c) fn++;
    }
    total += tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
  }
  return total / classes;
}

export function trainForest(rows: Row[], target: string, features: FeatureSpec[], task: "regression" | "classification", seed = 42): TrainOutput {
  const random = rng(seed);
  let classes: string[] | undefined;
  const labelled = rows.filter((row) => row[target] !== null && row[target] !== undefined);
  if (labelled.length < 30) throw new Error(`Training needs at least 30 rows with a value in ${target}; found ${labelled.length}.`);
  if (features.length === 0) throw new Error("No usable feature columns.");

  let y: number[];
  if (task === "classification") {
    const counts = new Map<string, number>();
    for (const row of labelled) counts.set(String(row[target]), (counts.get(String(row[target])) ?? 0) + 1);
    if (counts.size < 2) throw new Error(`${target} has only one value, so there is nothing to predict.`);
    if (counts.size > 30) throw new Error(`${target} has ${counts.size} categories. Classification supports up to 30.`);
    classes = [...counts.keys()].sort();
    const lookup = new Map(classes.map((c, i) => [c, i]));
    y = labelled.map((row) => lookup.get(String(row[target]))!);
  } else {
    y = labelled.map((row) => Number(row[target]));
    if (new Set(y).size < 2) throw new Error(`${target} has only one value, so there is nothing to predict.`);
  }

  const n = labelled.length;
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const testCount = Math.max(5, Math.floor(n * 0.2));
  const test = order.slice(0, testCount);
  const train = order.slice(testCount);

  // Encoders are fit on the training split only, so test metrics stay honest.
  const encoded = features.map((spec) => fitFeature(spec, labelled, y, train));
  const matrix = labelled.map((row) => encoded.map((feature) => encodeValue(feature, row[feature.name])));
  const bins = encoded.map((feature, f) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = binOf(feature.thresholds, matrix[i][f]);
    return out;
  });

  const ctx: GrowContext = {
    bins,
    thresholds: encoded.map((f) => f.thresholds),
    y: Float64Array.from(y),
    classes: classes?.length ?? 0,
    mtry: task === "regression" ? Math.max(1, Math.ceil(features.length / 3)) : Math.max(1, Math.ceil(Math.sqrt(features.length))),
    random,
  };

  const trees: Tree[] = [];
  for (let t = 0; t < TREES; t++) {
    const sample = new Int32Array(train.length);
    for (let i = 0; i < train.length; i++) sample[i] = train[Math.floor(random() * train.length)];
    trees.push(growTree(ctx, sample));
  }

  const artifact: ForestArtifact = { task, features: encoded, classes, trees };
  const actual = test.map((i) => y[i]);
  const raw = test.map((i) => predictEncoded(artifact, matrix[i]));
  const metrics: Record<string, number> = {};
  const baseline: Record<string, number> = {};
  const warnings: string[] = [];
  let confusion: number[][] | undefined;
  let sample: { actual: number; predicted: number }[] | undefined;

  // Scores a prediction set so permutation importance can reuse the same measure.
  let score: (predictions: number[][]) => number;
  if (task === "regression") {
    const trainMean = train.reduce((sum, i) => sum + y[i], 0) / train.length;
    const predicted = raw.map((p) => p[0]);
    const errors = predicted.map((p, i) => Math.abs(p - actual[i]));
    const ssRes = predicted.reduce((sum, p, i) => sum + (p - actual[i]) ** 2, 0);
    const testMean = actual.reduce((a, b) => a + b, 0) / actual.length;
    const ssTot = actual.reduce((sum, v) => sum + (v - testMean) ** 2, 0);
    metrics.r2 = ssTot ? 1 - ssRes / ssTot : 0;
    metrics.mae = errors.reduce((a, b) => a + b, 0) / errors.length;
    metrics.rmse = Math.sqrt(ssRes / actual.length);
    baseline.mae = actual.reduce((sum, v) => sum + Math.abs(v - trainMean), 0) / actual.length;
    artifact.residual90 = [...errors].sort((a, b) => a - b)[Math.floor(errors.length * 0.9)];
    sample = predicted.slice(0, 300).map((p, i) => ({ actual: actual[i], predicted: p }));
    score = (predictions) => -predictions.reduce((sum, p, i) => sum + Math.abs(p[0] - actual[i]), 0) / actual.length;
    if (metrics.mae >= baseline.mae) {
      warnings.push("This model is no better than always guessing the average. These columns may not explain the target.");
    }
    if (metrics.r2 > 0.995) warnings.push("Almost perfect accuracy is usually a warning sign: a feature may be derived from the target.");
  } else {
    const k = classes!.length;
    const predicted = raw.map(argmax);
    metrics.accuracy = predicted.filter((p, i) => p === actual[i]).length / actual.length;
    metrics.f1 = macroF1(actual, predicted, k);
    const trainCounts = new Array<number>(k).fill(0);
    for (const i of train) trainCounts[y[i]]++;
    const majority = argmax(trainCounts);
    baseline.accuracy = actual.filter((v) => v === majority).length / actual.length;
    confusion = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    predicted.forEach((p, i) => confusion![actual[i]][p]++);
    if (k === 2) metrics.auc = aucBinary(raw.map((p) => p[1]), actual);
    score = (predictions) => predictions.filter((p, i) => argmax(p) === actual[i]).length / actual.length;
    if (metrics.accuracy <= baseline.accuracy) {
      warnings.push(`This model is no better than always guessing "${classes![majority]}". These columns may not explain the target.`);
    }
    if (metrics.accuracy > 0.995) warnings.push("Almost perfect accuracy is usually a warning sign: a feature may be derived from the target.");
  }

  // Permutation importance: how much does the test score drop when a column is shuffled?
  const base = score(raw);
  const drops = encoded.map((_, f) => {
    const shuffled = test.map((i) => matrix[i][f]);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const predictions = test.map((row, i) => {
      const x = [...matrix[row]];
      x[f] = shuffled[i];
      return predictEncoded(artifact, x);
    });
    return Math.max(0, base - score(predictions));
  });
  const totalDrop = drops.reduce((a, b) => a + b, 0);
  const shares = drops.map((d) => (totalDrop ? d / totalDrop : 0));
  const top = shares.indexOf(Math.max(...shares));
  if (shares[top] > 0.9 && features.length > 2) {
    warnings.push(`Nearly all predictive power comes from ${encoded[top].name}. Check that it isn't known only after the outcome.`);
  }

  return {
    artifact,
    summary: {
      target,
      task,
      features: encoded
        .map((f, i) => ({
          name: f.name,
          type: f.kind,
          importance: shares[i],
          levels: f.levels?.filter((level) => level !== OTHER),
          min: f.min,
          max: f.max,
          median: f.kind === "numeric" ? f.median : undefined,
        }))
        .sort((a, b) => b.importance - a.importance),
      rowsTrained: train.length,
      rowsTested: test.length,
      metrics,
      baseline,
      classes,
      confusion,
      sample,
      warnings,
    },
  };
}

export function predictRow(artifact: ForestArtifact, input: Row): PredictionResult {
  const x = artifact.features.map((feature) => encodeValue(feature, input[feature.name]));
  const output = predictEncoded(artifact, x);
  if (artifact.task === "regression") {
    const margin = artifact.residual90 ?? 0;
    return { prediction: output[0], low: output[0] - margin, high: output[0] + margin };
  }
  const probabilities = artifact.classes!.map((label, i) => ({ label, probability: output[i] })).sort((a, b) => b.probability - a.probability);
  return { prediction: probabilities[0].label, probabilities };
}
