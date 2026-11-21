# Plumb

Connect data, get it cleaned automatically, then chat with it, forecast it and build dashboards. Runs locally. The AI is Claude Sonnet 5.5.

## Start

You need Node 22.13 or newer and an [Anthropic API key](https://platform.claude.com/settings/keys).

```bash
npm install
```

```bash
copy .env.example .env.local
```

Put your key in `.env.local`, then:

```bash
npm run dev
```

Open http://127.0.0.1:3000 and press **Load sample data** for a deliberately messy example.

For everyday use, run the faster production build instead:

```bash
npm run build
```

```bash
npm start
```

If you change the key in `.env.local`, restart the app so it picks up the new one.

Everything except chat, AI review and dashboard generation works without a key.

## What it does

**Connect.** Drop any number of CSV, TSV, Excel (every sheet becomes a table), JSON or SQLite files, up to 200 MB each. Or import from PostgreSQL, MySQL, a file URL, a JSON API, or a Google Sheet shared by link. Database imports are snapshots of up to 500,000 rows per table, taken in a read-only session.

**Clean.** Runs automatically on import, and every change is reported:

- Finds the header row under report titles, and removes blank rows, repeated headers and "Total" rows
- Reads mixed date formats, including day/month order, and warns when the order can't be proven
- Reads `$1,234.50`, `(1,200)`, `1.234,50`, `45%` and `1.5k` as numbers
- Keeps ZIP codes and other leading-zero identifiers as text
- Merges spelling variants like `USA`, `usa` and `U.S.A`, and removes exact duplicates
- Handles UTF-8, UTF-16 and Windows-1252 files

Judgment calls, like filling missing values or removing outliers, are only suggested. **Review with Claude** also looks for problems rules can't see, such as a misspelled city. Nothing changes until you press Apply, and every applied step can be undone.

**Chat.** Claude writes SQL against your tables, charts the results, and can run forecasts and train models. Every chart has a data table view and a CSV download, and can be pinned to a dashboard.

**Dashboards.** Claude designs KPIs and charts from your data, runs every query, repairs any that fail, then writes insights from the actual results. Dashboards re-query on each load.

**Timeline.** Log what happened and when, such as a promotion, outage or release, and it appears on charts across the app. Plumb also finds unusual days by itself, allowing for trend and weekday or seasonal patterns. Select a day to see which segments account for the change, or press **Measure** on an event to compare the periods before and after it. That result is checked against how often ordinary dates show a change that large, so normal seasonality isn't reported as an effect. Chat can do all of this too, for example "what happened on March 12?".

**Streams.** Send live data from your pipelines. Each stream gets a secure endpoint, with setup snippets for curl, Python, Airflow, Spark, Kafka Connect, Vector, dbt Cloud and Fivetran. Plumb can also read a Kafka topic directly. Rows land in a table, new fields become new columns, and open dashboards update by themselves. Pipeline events, such as a failed dbt or Airflow run, can land on the Timeline instead.

**Predict.** Forecasts compare several methods by backtest on your own data and report accuracy against a simple baseline. Outcome models are random forests evaluated on held-out rows, with what-if scoring. All of this math runs locally, so the accuracy figures come from your data, not from the language model.

## Data and privacy

- Everything is stored in `.data/` in this folder. Delete it to reset.
- Importing, cleaning, forecasts, models and the Timeline's statistics run on this machine and send nothing anywhere.
- Chat, data review and dashboard generation send table and column names, column statistics, small samples and query results to the Anthropic API. Personal data in them is masked first, as described below.
- Database connection strings are used for one import and never saved.

### How personal data is masked

Before anything reaches Claude, Plumb replaces personal values with tokens such as `email_3fa91c` or `name_8b21d0`. A value always gets the same token, so Claude can still group, count and filter by it, but it never sees the value itself.

- **Which columns.** A column counts as personal when its name says so (email, phone, name, address, postcode, card or account number, government ID, IP address, date of birth) or when most sampled values look like emails, phone numbers, card numbers that pass the card check digit, US social security numbers, IP addresses, or many distinct person names. The Columns tab on each table shows what was detected, and you can switch any column to masked or sent as is.
- **Values in any column.** Text sent to Claude is also scanned for emails, phone numbers, card numbers, social security numbers and IP addresses, wherever they appear.
- **Renamed columns.** If a query renames a personal column (`SELECT full_name AS who`), the values that come back are checked against your personal columns and masked anyway.
- **Summaries.** Claude never sees the most common values, ranges or examples of a personal column.
- **What you type.** Emails and phone numbers in your messages are masked, as are names that match a personal column.
- **Swapping back.** When Claude writes SQL with a token, the real value is put back on your machine before the query runs, and tokens in Claude's answers are shown to you as the real values.
- **Errors.** A database error that quotes a personal value is masked before Claude sees it.

Tokens come from a keyed hash. The key is created once in `.data/privacy.key` and never leaves this machine, so a token can't be turned back into a value without it. Token-to-value pairs are saved with each chat in `.data`, on this machine only.

**Limits.** Masking is automatic, so treat it as a strong safety net, not a guarantee. Free text such as a notes column can hold a name that matches no pattern and no personal column; mark such columns as masked yourself. Over-masking can happen too: a column named `name` is masked in every table, including product names. Use **Send as is** where that's safe.

## Safety

SQL written by the model can't change data or reach outside the database. DuckDB runs with external access disabled, so SQL can't touch files or the network. Queries must parse to a single `SELECT`, and they time out after 30 seconds. Table contents are treated as untrusted data: chat renders no images, so data can't be sent out through an image URL, and CSV exports neutralize spreadsheet formulas.

There is no login. The app listens on 127.0.0.1 only and rejects requests from other sites. Don't expose it to a network without adding authentication.

### Streaming from other machines

`npm run start:network` listens on all network interfaces so pipelines on other machines can reach the ingest endpoint. Only `/api/ingest` answers remote requests, and each stream needs its token, which is stored only as a hash. Everything else still rejects non-local requests. Traffic is plain HTTP, so put it behind a TLS proxy or tunnel if it leaves a trusted network. Tools in Docker can usually reach it at `host.docker.internal:3000`.

### Delivery

- HTTP: the reply comes after the rows are saved, so a sender that gets an error can safely retry.
- Kafka: offsets are committed after the rows are saved. A crash can redeliver messages, so set a unique ID field on the stream to skip repeats.
- Kafka messages must be JSON. Avro and Protobuf with a schema registry aren't supported.
- SASL credentials come from `KAFKA_SASL_USERNAME` and `KAFKA_SASL_PASSWORD` in `.env.local`.

## Limits

- Files are parsed in memory, so very large files need a matching amount of RAM. A 620,000-row CSV took about 7 seconds.
- Only one running copy can use `.data/` at a time, because DuckDB locks its file.
- Model training uses up to 20,000 sampled rows and doesn't use date columns.
- Database imports are snapshots. To refresh that data, import it again, or send changes through a stream.
- Each HTTP request can carry up to 100,000 records or 50 MB.
- A stream's first batch sets its column types. Numbers can later widen to decimals and dates to timestamps. A value that fits neither is blanked and counted on the Streams page.
- Unusual-period detection needs at least 14 periods of history.
- Claude can't reason about what a masked value means. For example, it can't tell which customers share a surname.
- A short incident in a low-volume group can be missed. Automatic scans skip a drop that could plausibly be chance, so at around 6 rows a day a single empty day stays off the list. You can still look up that date yourself.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

The stack is Next.js, DuckDB, the Anthropic TypeScript SDK and Recharts. The model is set in `src/lib/ai/client.ts`.
