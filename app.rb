require "sinatra/base"
require "net/http"
require "json"
require "uri"

# Thin JSON proxy over Yahoo Finance public endpoints (no API key required).
# The browser cannot call Yahoo directly because of CORS, so we fetch server-side
# and cache responses for a short time to stay polite.
class StockApp < Sinatra::Base
  set :public_folder, File.join(__dir__, "public")
  set :bind, "0.0.0.0"
  set :static_cache_control, [:public, :no_cache]
  set :host_authorization, { permitted_hosts: [] } if settings.respond_to?(:host_authorization)

  # Yahoo rate-limits (429) full browser user agents without cookies; a bare one is accepted.
  USER_AGENT = "Mozilla/5.0".freeze
  YAHOO_HOSTS = %w[query1.finance.yahoo.com query2.finance.yahoo.com].freeze

  # range key => Yahoo query params. "1w" is not a native Yahoo range, so it uses period1.
  RANGES = {
    "1d"  => { range: "1d",  interval: "5m",  ttl: 30 },
    "5d"  => { range: "5d",  interval: "15m", ttl: 60 },
    "1w"  => { days: 7,      interval: "30m", ttl: 60 },
    "1m"  => { range: "1mo", interval: "1h",  ttl: 300 },
    "6m"  => { range: "6mo", interval: "1d",  ttl: 600 },
    "ytd" => { range: "ytd", interval: "1d",  ttl: 600 },
    "1y"  => { range: "1y",  interval: "1d",  ttl: 600 },
    "5y"  => { range: "5y",  interval: "1wk", ttl: 3600 },
    "max" => { range: "max", interval: "1mo", ttl: 3600 }
  }.freeze

  ALLOWED_TYPES = %w[EQUITY ETF INDEX MUTUALFUND CRYPTOCURRENCY CURRENCY FUTURE].freeze

  CACHE = {}
  CACHE_LOCK = Mutex.new

  class UpstreamError < StandardError; end

  helpers do
    def json(data, status_code = 200)
      content_type :json
      halt status_code, JSON.generate(data)
    end

    def cached(key, ttl)
      now = Time.now.to_f
      CACHE_LOCK.synchronize do
        hit = CACHE[key]
        return hit[:value] if hit && hit[:expires] > now
      end
      value = yield
      CACHE_LOCK.synchronize do
        CACHE.delete_if { |_, v| v[:expires] < now } if CACHE.size > 500
        CACHE[key] = { value: value, expires: now + ttl }
      end
      value
    end

    def yahoo_get(path, params)
      last_error = nil
      YAHOO_HOSTS.each do |host|
        uri = URI::HTTPS.build(host: host, path: path, query: URI.encode_www_form(params))
        begin
          res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 10) do |http|
            http.get(uri.request_uri, "User-Agent" => USER_AGENT, "Accept" => "application/json")
          end
          body = JSON.parse(res.body) rescue nil
          return body if res.is_a?(Net::HTTPSuccess) && body
          return body if res.code == "404" && body # unknown symbol: let caller report it
          last_error = "Yahoo responded #{res.code}"
        rescue StandardError => e
          last_error = e.message
        end
      end
      raise UpstreamError, last_error
    end
  end

  get "/" do
    send_file File.join(settings.public_folder, "index.html")
  end

  get "/health" do
    "ok"
  end

  get "/api/search" do
    q = params[:q].to_s.strip
    json([]) if q.empty? || q.length > 40

    results = cached("search:#{q.downcase}", 300) do
      data = yahoo_get("/v1/finance/search",
                       q: q, quotesCount: 10, newsCount: 0, listsCount: 0, enableFuzzyQuery: false)
      (data["quotes"] || [])
        .select { |r| r["symbol"] && ALLOWED_TYPES.include?(r["quoteType"]) }
        .map do |r|
          {
            symbol: r["symbol"],
            name: r["longname"] || r["shortname"] || r["symbol"],
            exchange: r["exchDisp"] || r["exchange"],
            type: r["typeDisp"] || r["quoteType"]
          }
        end
    end
    json(results)
  rescue UpstreamError => e
    json({ error: "Search service unavailable (#{e.message})" }, 502)
  end

  get "/api/chart/:symbol" do
    symbol = params[:symbol].to_s.upcase
    json({ error: "Invalid symbol" }, 400) unless symbol.match?(/\A[A-Z0-9.\-=^]{1,20}\z/)
    cfg = RANGES[params[:range].to_s.downcase] || RANGES["1d"]

    query = { interval: cfg[:interval], includePrePost: false, events: "div,split" }
    if cfg[:days]
      query[:period2] = Time.now.to_i
      query[:period1] = query[:period2] - cfg[:days] * 86_400
    else
      query[:range] = cfg[:range]
    end

    payload = cached("chart:#{symbol}:#{params[:range]}", cfg[:ttl]) do
      data = yahoo_get("/v8/finance/chart/#{URI.encode_www_form_component(symbol)}", query)
      result = data.dig("chart", "result", 0)
      raise ArgumentError, data.dig("chart", "error", "description") || "No data for #{symbol}" unless result

      meta = result["meta"] || {}
      quote = result.dig("indicators", "quote", 0) || {}
      times = result["timestamp"] || []
      candles = times.each_with_index.map do |t, i|
        o, h, l, c = %w[open high low close].map { |k| quote[k]&.[](i) }
        next if [o, h, l, c].any?(&:nil?)
        { time: t, open: o, high: h, low: l, close: c, volume: quote["volume"]&.[](i) || 0 }
      end.compact

      {
        symbol: meta["symbol"] || symbol,
        name: meta["longName"] || meta["shortName"] || symbol,
        currency: meta["currency"],
        exchange: meta["fullExchangeName"] || meta["exchangeName"],
        timezone: meta["exchangeTimezoneName"],
        gmtoffset: meta["gmtoffset"] || 0,
        price: meta["regularMarketPrice"],
        previousClose: meta["chartPreviousClose"] || meta["previousClose"],
        dayHigh: meta["regularMarketDayHigh"],
        dayLow: meta["regularMarketDayLow"],
        volume: meta["regularMarketVolume"],
        high52: meta["fiftyTwoWeekHigh"],
        low52: meta["fiftyTwoWeekLow"],
        marketTime: meta["regularMarketTime"],
        interval: cfg[:interval],
        intraday: cfg[:interval].end_with?("m", "h"),
        candles: candles
      }
    end
    json(payload)
  rescue ArgumentError => e
    json({ error: e.message }, 404)
  rescue UpstreamError => e
    json({ error: "Market data unavailable (#{e.message})" }, 502)
  end
end
