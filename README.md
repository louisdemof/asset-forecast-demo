# Asset Forecast — Solar Revenue Platform (Demo)

A web app for forecasting and reconciling the revenue of a distributed-solar
generation portfolio (Brazil's SCEE / net-metering scheme). It turns per-plant
tariffs, generation curves and commercial contracts into a month-by-month revenue
forecast, then reconciles that forecast against real distributor invoices.

> **This is a portfolio demo.** All data is **synthetic** — client names, plant
> names, meter/UC numbers and figures are invented. It ships with **no login and
> no backend** (edits are session-only). The production version runs behind an
> encrypted access gate with a Supabase backend (auth, RBAC, audit, persistence).

**Live demo:** _add your Vercel URL here_

---

## What it does

- **Revenue engine** — one source-of-truth formula (`Revenue = BaseRate × Energy − Demand`)
  replacing a fragile multi-tab spreadsheet. Each client (offtaker) is a single rule
  describing its fiscal gross-up and how the residual is split across cost lines.
- **Per-plant forecast** — capacity, P50 generation curve, tariff, discount and
  connection dates roll up into a 12-month portfolio forecast.
- **Invoice parsing** — drop a distributor PDF invoice and it extracts injection,
  credit balance and demand. Nine distributor layouts are supported, with an
  in-browser **OCR fallback** (Tesseract, 432 DPI render + binarization) for scanned
  invoices. Parsed fields stay editable.
- **Reconciliation** — compares forecast vs. metered/invoiced values and surfaces
  the variance, so a portfolio of ~90 plants can be validated each month.
- **Editable methods** — the calculation rules and discounts are editable in-app.
- **Plant onboarding wizard** — a multi-step form to add a new plant to the forecast.

## Tech

- **React 19 + TypeScript + Vite** · **Zustand** for state
- **pdf.js** + **tesseract.js** (in-browser invoice OCR)
- Pure-TS revenue engine (no server needed to run the forecast)
- Production backend (not in this demo): **Supabase** — Postgres, Row-Level
  Security, a Salesforce-style RBAC model (departments · roles · permissions ·
  manager hierarchy) and full audit trails. The schema lives in [`supabase/`](supabase/).

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

Build: `npm run build` → static output in `dist/` (deploys to any static host / Vercel).

## Architecture notes

- `src/engine/` — the revenue engine: `clientes.ts` (offtaker rules),
  `contrato.ts` (per-plant contract), `comercial.ts`.
- `src/data/` — CSV/JSON loaders and the invoice parser (`parseFaturaGeradora.ts`).
- `src/components/` — the panels (Revenue, Generation, Compensation, Methods,
  Reconciliation, plant-onboarding wizard).
- `src/store/forecastStore.ts` — Zustand store; the engine recomputes on every edit.
- The UI is in Portuguese (the tool's working language).
