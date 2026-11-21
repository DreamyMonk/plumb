export interface Snippet {
  id: string;
  label: string;
  note?: string;
  code: string;
}

/** Copy-paste setup for common tools. All of them use the same HTTP endpoint. */
export function httpSnippets(url: string, token: string, target: "table" | "events"): Snippet[] {
  const sample = target === "events" ? `{"date": "2026-11-05", "title": "Nightly load failed", "category": "incident"}` : `[{"order_id": "A1", "ts": "2026-11-05T10:15:00Z", "amount": 42.5}]`;
  const hookUrl = `${url}?token=${token}`;
  const common: Snippet[] = [
    {
      id: "curl",
      label: "curl",
      code: `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '${sample}'`,
    },
    {
      id: "python",
      label: "Python",
      code: `import requests

records = ${sample}
response = requests.post(
    "${url}",
    headers={"Authorization": "Bearer ${token}"},
    json=records,
    timeout=30,
)
response.raise_for_status()
print(response.json())  # accepted, duplicates, rejected`,
    },
  ];
  const airflow: Snippet =
    target === "events"
      ? {
          id: "airflow",
          label: "Airflow",
          note: "Put failures and finished runs on the Timeline. Attach this to a DAG's default_args.",
          code: `import requests

def notify_plumb(context):
    requests.post(
        "${url}",
        headers={"Authorization": "Bearer ${token}"},
        json={
            "dag_id": context["dag"].dag_id,
            "task_id": context["task_instance"].task_id,
            "state": context["task_instance"].state,
            "logical_date": context["logical_date"].isoformat(),
        },
        timeout=10,
    )

default_args = {"on_failure_callback": notify_plumb}`,
        }
      : {
          id: "airflow",
          label: "Airflow",
          note: "Push a task's output at the end of a DAG.",
          code: `import requests
from airflow.decorators import task

@task
def push_to_plumb(rows: list[dict]):
    response = requests.post(
        "${url}",
        headers={"Authorization": "Bearer ${token}"},
        json=rows,
        timeout=60,
    )
    response.raise_for_status()`,
        };
  if (target === "events") {
    return [
      ...common,
      airflow,
      {
        id: "dbt",
        label: "dbt Cloud",
        note: "In dbt Cloud, open Account settings, then Webhooks, and add this URL as the endpoint for job run events.",
        code: hookUrl,
      },
      {
        id: "fivetran",
        label: "Fivetran",
        note: "Register this URL with Fivetran's webhooks API for sync events.",
        code: `curl -X POST "https://api.fivetran.com/v1/webhooks/account" \\
  -u "$FIVETRAN_API_KEY:$FIVETRAN_API_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "${hookUrl}", "events": ["sync_start", "sync_end"], "active": true}'`,
      },
    ];
  }
  return [
    ...common,
    airflow,
    {
      id: "spark",
      label: "Spark",
      note: "Send each micro-batch from Structured Streaming.",
      code: `import requests

def push_batch(batch_df, batch_id):
    rows = [row.asDict() for row in batch_df.limit(10000).collect()]
    if rows:
        requests.post(
            "${url}",
            headers={"Authorization": "Bearer ${token}"},
            json=rows,
            timeout=60,
        ).raise_for_status()

stream.writeStream.foreachBatch(push_batch).start()`,
    },
    {
      id: "connect",
      label: "Kafka Connect",
      note: "Confluent's HTTP Sink connector. Use this when Plumb can't reach your brokers directly.",
      code: `{
  "name": "plumb-sink",
  "config": {
    "connector.class": "io.confluent.connect.http.HttpSinkConnector",
    "topics": "orders",
    "http.api.url": "${url}",
    "request.method": "POST",
    "headers": "Content-Type:application/json|Authorization:Bearer ${token}",
    "batch.json.as.array": "true",
    "batch.max.size": "500"
  }
}`,
    },
    {
      id: "vector",
      label: "Vector",
      code: `[sinks.plumb]
type = "http"
inputs = ["your_source"]
uri = "${url}"
encoding.codec = "json"
framing.method = "newline_delimited"
auth.strategy = "bearer"
auth.token = "${token}"`,
    },
  ];
}
