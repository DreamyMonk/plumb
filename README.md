# Sift

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

**Predict.** Forecasts compare several methods by backtest on your own data and report accuracy against a simple baseline. Outcome models are random forests evaluated on held-out rows, with what-if scoring. All of this math runs locally, so the accuracy figures come from your data, not from the language model.

## Data and privacy

- Everything is stored in `.data/` in this folder. Delete it to reset.
- Questions, table and column names, column statistics, sample rows and query results are sent to the Anthropic API when you use an AI feature. Forecasting, model training and automatic cleaning send nothing.
- Database connection strings are used for one import and never saved.

## Safety

SQL written by the model can't change data or reach outside the database. DuckDB runs with external access disabled, so SQL can't touch files or the network. Queries must parse to a single `SELECT`, and they time out after 30 seconds. Table contents are treated as untrusted data: chat renders no images, so data can't be sent out through an image URL, and CSV exports neutralize spreadsheet formulas.

There is no login. The app listens on 127.0.0.1 only and rejects requests from other sites. Don't expose it to a network without adding authentication.

## Limits

- Files are parsed in memory, so very large files need a matching amount of RAM. A 620,000-row CSV took about 7 seconds.
- Only one running copy can use `.data/` at a time, because DuckDB locks its file.
- Model training uses up to 20,000 sampled rows and doesn't use date columns.
- Imports are snapshots. To refresh database data, import it again.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

The stack is Next.js, DuckDB, the Anthropic TypeScript SDK and Recharts. The model is set in `src/lib/ai/client.ts`.
