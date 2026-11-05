import { describe, expect, it } from "vitest";
import { addPeriods, inferGrain, runForecast } from "../src/lib/ml/forecast";
import { predictRow, trainForest } from "../src/lib/ml/forest";

function monthlyDates(n: number) {
  return Array.from({ length: n }, (_, i) => addPeriods("2021-01-01", "month", i));
}

describe("runForecast", () => {
  it("beats naive on a trending seasonal series and picks a seasonal model", () => {
    const n = 48;
    const values = Array.from({ length: n }, (_, i) => 100 + 3 * i + 25 * Math.sin((2 * Math.PI * i) / 12));
    const result = runForecast({ dates: monthlyDates(n), values, grain: "month", horizon: 6 });
    expect(result.model).toMatch(/^hw_/);
    expect(result.skill).toBeGreaterThan(0.5);
    expect(result.points).toHaveLength(n + 6);
    const expected = 100 + 3 * n + 25 * Math.sin((2 * Math.PI * n) / 12);
    expect(Math.abs(result.points[n].forecast! - expected)).toBeLessThan(15);
    expect(result.points[n].lower!).toBeLessThan(result.points[n].forecast!);
    expect(result.points[n + 5].upper! - result.points[n + 5].lower!).toBeGreaterThan(
      result.points[n].upper! - result.points[n].lower!,
    );
  });

  it("warns and skips seasonality with too little history", () => {
    const values = [10, 12, 13, 15, 16, 18, 19, 21];
    const result = runForecast({ dates: monthlyDates(8), values, grain: "month", horizon: 3 });
    expect(result.seasonLength).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/seasonality/);
  });

  it("refuses very short series", () => {
    expect(() => runForecast({ dates: monthlyDates(3), values: [1, 2, 3], grain: "month", horizon: 2 })).toThrow(/at least 6/);
  });

  it("never forecasts negative counts", () => {
    const values = Array.from({ length: 24 }, (_, i) => 200 - i * 8);
    const result = runForecast({ dates: monthlyDates(24), values, grain: "month", horizon: 12 });
    expect(result.points.slice(24).every((p) => p.forecast! >= 0 && p.lower! >= 0)).toBe(true);
  });

  it("admits when noise cannot be predicted", () => {
    let seed = 7;
    const noise = Array.from({ length: 60 }, () => {
      seed = (seed * 9301 + 49297) % 233280;
      return 100 + (seed / 233280) * 40;
    });
    const result = runForecast({ dates: monthlyDates(60), values: noise, grain: "month", horizon: 6 });
    expect(result.mape).toBeGreaterThan(0.03); // an honest non-zero error on pure noise
  });
});

describe("addPeriods", () => {
  it("steps calendar units", () => {
    expect(addPeriods("2024-01-31", "day", 1)).toBe("2024-02-01");
    expect(addPeriods("2024-01-01", "quarter", 2)).toBe("2024-07-01");
    expect(addPeriods("2024-01-01", "week", 1)).toBe("2024-01-08");
  });
});

describe("inferGrain", () => {
  it("reads the spacing", () => {
    expect(inferGrain(["2024-01-01", "2024-01-02", "2024-01-03"])).toBe("day");
    expect(inferGrain(["2024-01-01", "2024-02-01", "2024-03-01"])).toBe("month");
    expect(inferGrain(["2020-01-01", "2021-01-01", "2022-01-01"])).toBe("year");
  });

  it("rolls long daily histories up to a period that forecasts well", () => {
    const daily = (days: number) => Array.from({ length: days }, (_, i) => addPeriods("2022-01-01", "day", i));
    expect(inferGrain(daily(90))).toBe("day");
    expect(inferGrain(daily(400))).toBe("week");
    expect(inferGrain(daily(1000))).toBe("month");
  });
});

describe("trainForest", () => {
  const seeded = (seed: number) => () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  it("learns a nonlinear regression and ranks the real driver first", () => {
    const r = seeded(11);
    const rows = Array.from({ length: 1500 }, () => {
      const x = r() * 10;
      const noise = r();
      const region = ["n", "s", "e"][Math.floor(r() * 3)];
      return { x, noise, region, y: x * x + (region === "n" ? 20 : 0) + r() * 2 };
    });
    const { summary, artifact } = trainForest(rows, "y", [
      { name: "x", kind: "numeric" },
      { name: "noise", kind: "numeric" },
      { name: "region", kind: "categorical" },
    ], "regression");
    expect(summary.metrics.r2).toBeGreaterThan(0.9);
    expect(summary.metrics.mae).toBeLessThan(summary.baseline.mae / 3);
    expect(summary.features[0].name).toBe("x");
    expect(summary.features.find((f) => f.name === "noise")!.importance).toBeLessThan(0.05);
    const prediction = predictRow(artifact, { x: 9, noise: 0.5, region: "n" });
    expect(Number(prediction.prediction)).toBeGreaterThan(85);
    expect(Number(prediction.prediction)).toBeLessThan(115);
  });

  it("classifies and reports AUC above baseline", () => {
    const r = seeded(5);
    const rows = Array.from({ length: 1000 }, () => {
      const score = r();
      const plan = r() > 0.5 ? "pro" : "free";
      const churn = score + (plan === "free" ? 0.3 : 0) + (r() - 0.5) * 0.2 > 0.8 ? "yes" : "no";
      return { score, plan, churn };
    });
    const { summary, artifact } = trainForest(rows, "churn", [
      { name: "score", kind: "numeric" },
      { name: "plan", kind: "categorical" },
    ], "classification");
    expect(summary.metrics.accuracy).toBeGreaterThan(summary.baseline.accuracy);
    expect(summary.metrics.auc).toBeGreaterThan(0.9);
    const out = predictRow(artifact, { score: 0.95, plan: "free" });
    expect(out.prediction).toBe("yes");
    expect(out.probabilities!.reduce((sum, p) => sum + p.probability, 0)).toBeCloseTo(1);
  });

  it("flags a feature that leaks the target", () => {
    const r = seeded(3);
    const rows = Array.from({ length: 400 }, () => {
      const y = r() * 100;
      return { a: r(), b: r(), leak: y * 2, y };
    });
    const { summary } = trainForest(rows, "y", [
      { name: "a", kind: "numeric" },
      { name: "b", kind: "numeric" },
      { name: "leak", kind: "numeric" },
    ], "regression");
    expect(summary.warnings.join(" ")).toMatch(/derived from the target|Nearly all/);
  });

  it("says when features explain nothing", () => {
    const r = seeded(9);
    const rows = Array.from({ length: 300 }, () => ({ a: r(), y: r() > 0.5 ? "p" : "q" }));
    const { summary } = trainForest(rows, "y", [{ name: "a", kind: "numeric" }], "classification");
    expect(summary.metrics.accuracy).toBeLessThan(0.7);
  });

  it("treats unseen and missing inputs without crashing", () => {
    const r = seeded(13);
    const rows = Array.from({ length: 200 }, () => {
      const v = r();
      return { v, cat: v > 0.5 ? "a" : "b", y: v * 3 };
    });
    const { artifact } = trainForest(rows, "y", [
      { name: "v", kind: "numeric" },
      { name: "cat", kind: "categorical" },
    ], "regression");
    expect(Number.isFinite(Number(predictRow(artifact, { v: null, cat: "never-seen" }).prediction))).toBe(true);
  });

  it("rejects too few rows", () => {
    expect(() => trainForest([{ a: 1, y: 1 }], "y", [{ name: "a", kind: "numeric" }], "regression")).toThrow(/at least 30/);
  });
});
