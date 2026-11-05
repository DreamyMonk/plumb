"use client";

import { ArrowRight, FlaskConical, Rows3 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Connect } from "@/components/Connect";
import { Badge, Button, Card, Note, PageHeader, Spinner } from "@/components/ui";
import { notifyDatasets, post, useApi } from "@/lib/client";
import { timeAgo } from "@/lib/format";
import type { Dataset } from "@/lib/types";

function Score({ before, after }: { before: number; after: number }) {
  return (
    <span className="tnum text-[12.5px] text-ink-2" aria-label={`Quality score went from ${before} to ${after}`}>
      Quality {before} <ArrowRight size={11} className="inline -mt-0.5" aria-hidden /> <span className="font-semibold text-ink">{after}</span>
    </span>
  );
}

function DatasetCard({ dataset }: { dataset: Dataset }) {
  const fixes = dataset.report.actions.filter((action) => action.kind !== "rename").length;
  return (
    <Link href={`/data/${dataset.id}`} className="block rise">
      <Card className="p-4 h-full hover:border-ink-3 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold truncate">{dataset.label}</p>
          <Badge>{dataset.source.kind}</Badge>
        </div>
        <p className="text-[12.5px] text-ink-3 mt-0.5">{timeAgo(dataset.createdAt)}</p>
        <p className="mt-3 flex items-center gap-1.5 text-[13px] tnum">
          <Rows3 size={13} className="text-ink-3" aria-hidden />
          {dataset.rowCount.toLocaleString()} rows · {dataset.columns.length} columns
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <Score before={dataset.report.qualityBefore.score} after={dataset.report.qualityAfter.score} />
          <span className="text-[12.5px] text-ink-3">{fixes} {fixes === 1 ? "fix" : "fixes"}</span>
        </div>
      </Card>
    </Link>
  );
}

export default function HomePage() {
  const { data: datasets, error, refresh } = useApi<Dataset[]>("/api/datasets");
  const [errors, setErrors] = useState<{ file: string; message: string }[]>([]);
  const [loadingSample, setLoadingSample] = useState(false);

  const onImported = (result: { errors: { file: string; message: string }[] }) => {
    setErrors(result.errors);
    void refresh();
  };

  const loadSample = async () => {
    setLoadingSample(true);
    try {
      onImported(await post("/api/samples"));
      notifyDatasets();
    } catch (e) {
      setErrors([{ file: "Sample data", message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setLoadingSample(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-8 py-8">
      <PageHeader
        title="Your data"
        subtitle="Bring in files or a database. Sift cleans them, then you can ask questions, forecast and build dashboards."
        actions={
          <Button busy={loadingSample} onClick={() => void loadSample()}>
            <FlaskConical size={14} /> Load sample data
          </Button>
        }
      />
      <div className="space-y-3 mb-8">
        {error ? <Note tone="bad">{error}</Note> : null}
        {errors.map((item) => (
          <Note key={item.file} tone="bad" onClose={() => setErrors(errors.filter((e) => e !== item))}>
            <strong className="font-medium">{item.file}:</strong> {item.message}
          </Note>
        ))}
        <Connect onDone={onImported} />
      </div>
      {!datasets && !error ? <Spinner /> : null}
      {datasets?.length ? (
        <>
          <h2 className="font-semibold mb-3">Tables</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {datasets.map((dataset) => (
              <DatasetCard key={dataset.id} dataset={dataset} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
