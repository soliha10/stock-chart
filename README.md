# StockChart — Task 3.5 (Ruby group)

One-page web app: pick a stock with an autocomplete field and see an interactive chart with
current market data (Yahoo Finance, may be delayed a few minutes).

## Stack

- **Backend:** Ruby + Sinatra (`app.rb`) — a small JSON proxy to Yahoo Finance's public
  search/chart endpoints with in-memory caching (the browser can't call Yahoo directly because of CORS).
- **Frontend:** plain HTML/CSS/JS + [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0).

## Features

- Autocomplete search by ticker or company name (debounced, keyboard ↑/↓/Enter/Esc, `/` to focus, tap on mobile)
- Date ranges: 1D · 5D · 1W · 1M · 6M · YTD · 1Y · 5Y · MAX
- Chart types: candlesticks, area, line, OHLC bars
- Volume histogram, MA20 / MA50 overlays, log scale, previous-close line on 1D
- Pan/zoom (mouse drag & wheel, touch drag & pinch), reset zoom, fullscreen
- Crosshair legend with OHLC, change and volume for the hovered bar
- Shift + drag to measure price change between two points (desktop)
- Auto-refresh every 30 s, light/dark theme, state kept in URL (`/#TSLA/1y`) and localStorage
- Responsive layout tuned for phones (no zoom on input focus, full-width range bar, page scrolls vertically over the chart)

## API

| Endpoint | Description |
|---|---|
| `GET /api/search?q=apple` | `[{symbol, name, exchange, type}]` |
| `GET /api/chart/AAPL?range=1d` | quote metadata + `candles: [{time, open, high, low, close, volume}]` |
| `GET /health` | `ok` |

## Run locally

```sh
bundle install
bundle exec puma -p 4567 config.ru
# open http://localhost:4567
```

## Deploy (Render, free)

The repo contains a `Dockerfile` and `render.yaml`. On https://render.com → **New → Blueprint**
(or **Web Service → Docker**), point it at this repository; no environment variables are needed.
