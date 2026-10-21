"use strict";

const CONFIG = {
    PRICE_URL: "https://biquote.io/api/XAUUSD?allowStale=false",
    CANDLES_URL: "https://biquote.io/api/XAUUSD/ohlc?interval=1h&limit=500",
    EMA_FAST: 50,
    EMA_SLOW: 200,
    RSI_PERIOD: 14,
    ATR_PERIOD: 14,
    MIN_CANDLES: 30,
    REFRESH_INTERVAL: 60,
    ATR_STOP_MULTIPLIER: 1.5,
    RISK_REWARD: 2,
    FETCH_TIMEOUT: 15000
};

let isRefreshing = false;
let countdown = CONFIG.REFRESH_INTERVAL;

function el(id) {
    return document.getElementById(id);
}

function setText(id, value) {
    const element = el(id);
    if (element) element.textContent = value;
}

function formatPrice(value) {
    if (!Number.isFinite(value)) return "—";
    return value.toLocaleString("fr-FR", {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3
    });
}

function formatNumber(value, decimals = 2) {
    if (!Number.isFinite(value)) return "—";
    return value.toLocaleString("fr-FR", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

function showError(message) {
    const panel = el("error-panel");
    setText("error-message", message);
    if (panel) panel.hidden = false;
}

function hideError() {
    const panel = el("error-panel");
    if (panel) panel.hidden = true;
}

function setConnectionStatus(connected, message) {
    setText("connection-status", message);
    const dot = el("status-dot");

    if (dot) {
        dot.classList.toggle("connected", connected);
        dot.classList.toggle("disconnected", !connected);
    }
}

async function fetchJSON(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);

    try {
        const response = await fetch(url, {
            method: "GET",
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error("Erreur HTTP " + response.status);
        }

        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

function validateQuote(data) {
    if (!data || typeof data !== "object") {
        throw new Error("Réponse de prix invalide.");
    }

    const bid = Number(data.bid);
    const ask = Number(data.ask);

    const mid = Number.isFinite(Number(data.mid)) && Number(data.mid) > 0
        ? Number(data.mid)
        : (bid + ask) / 2;

    if (
        !Number.isFinite(bid) ||
        !Number.isFinite(ask) ||
        bid <= 0 ||
        ask < bid ||
        !Number.isFinite(mid)
    ) {
        throw new Error("Prix bid/ask invalides.");
    }

    if (data.stale === true) {
        throw new Error("La cotation reçue est ancienne.");
    }

    return {
        bid,
        ask,
        mid,
        marketState: data.marketState || "unknown",
        dayDiffPercent: Number(data.dayDiffPercent)
    };
}

function displayQuote(quote) {
    setText("current-price", formatPrice(quote.mid));

    if (Number.isFinite(quote.dayDiffPercent)) {
        const change = quote.dayDiffPercent;

        setText(
            "price-change",
            (change > 0 ? "+" : "") + formatNumber(change, 3) + " %"
        );

        const changeElement = el("price-change");

        if (changeElement) {
            changeElement.classList.toggle("positive", change > 0);
            changeElement.classList.toggle("negative", change < 0);
        }
    }

    const states = {
        open: "Marché ouvert",
        closed: "Marché fermé",
        unknown: "État inconnu"
    };

    setText("market-state", states[quote.marketState] || quote.marketState);

    setText(
        "last-update",
        new Date().toLocaleTimeString("fr-FR", { hour12: false })
    );

    setConnectionStatus(true, "Connecté à Biquote");
}

function normalizeCandles(response) {
    const bars = Array.isArray(response) ? response : response && response.bars;

    if (!Array.isArray(bars)) {
        throw new Error("L'API n'a pas fourni de bougies.");
    }

    const candles = bars
        .filter(bar => bar && bar.openTime && bar.isOpen !== true)
        .map(bar => ({
            time: new Date(bar.openTime).getTime(),
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close)
        }))
        .filter(c => (
            Number.isFinite(c.time) &&
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close) &&
            c.open > 0 &&
            c.high >= c.low &&
            c.high >= Math.max(c.open, c.close) &&
            c.low <= Math.min(c.open, c.close)
        ))
        .sort((a, b) => a.time - b.time);

    const unique = [];

    for (const candle of candles) {
        const previous = unique[unique.length - 1];

        if (!previous || previous.time !== candle.time) {
            unique.push(candle);
        }
    }

    if (unique.length < CONFIG.MIN_CANDLES) {
        throw new Error(
            "Seulement " + unique.length +
            " bougies valides. Au moins " +
            CONFIG.MIN_CANDLES + " sont nécessaires."
        );
    }

    return unique;
}

function calculateEMA(values, period) {
    const result = new Array(values.length).fill(null);

    if (values.length < period) return result;

    const multiplier = 2 / (period + 1);
    let sum = 0;

    for (let i = 0; i < period; i++) {
        sum += values[i];
    }

    let ema = sum / period;
    result[period - 1] = ema;

    for (let i = period; i < values.length; i++) {
        ema = values[i] * multiplier + ema * (1 - multiplier);
        result[i] = ema;
    }

    return result;
}

function calculateRSI(values, period = 14) {
    const result = new Array(values.length).fill(null);

    if (values.length <= period) return result;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];

        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    function rsiValue(gain, loss) {
        if (gain === 0 && loss === 0) return 50;
        if (loss === 0) return 100;

        const rs = gain / loss;
        return 100 - 100 / (1 + rs);
    }

    result[period] = rsiValue(averageGain, averageLoss);

    for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);

        averageGain = (
            averageGain * (period - 1) + gain
        ) / period;

        averageLoss = (
            averageLoss * (period - 1) + loss
        ) / period;

        result[i] = rsiValue(averageGain, averageLoss);
    }

    return result;
}

function calculateATR(candles, period = 14) {
    const result = new Array(candles.length).fill(null);

    if (candles.length < period) return result;

    const ranges = [];

    for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];

        if (i === 0) {
            ranges.push(candle.high - candle.low);
            continue;
        }

        const previousClose = candles[i - 1].close;

        ranges.push(Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - previousClose),
            Math.abs(candle.low - previousClose)
        ));
    }

    let sum = 0;

    for (let i = 0; i < period; i++) {
        sum += ranges[i];
    }

    let atr = sum / period;
    result[period - 1] = atr;

    for (let i = period; i < candles.length; i++) {
        atr = (atr * (period - 1) + ranges[i]) / period;
        result[i] = atr;
    }

    return result;
}

function displayIndicators(data) {
    const { ema50, ema200, rsi, atr, price } = data;

    setText(
        "ema-fast",
        Number.isFinite(ema50) ? formatPrice(ema50) : "Indisponible"
    );

    setText(
        "ema-fast-note",
        Number.isFinite(ema50)
            ? (price > ema50 ? "Prix au-dessus" : "Prix en dessous")
            : "Historique insuffisant"
    );

    setText(
        "ema-slow",
        Number.isFinite(ema200) ? formatPrice(ema200) : "Indisponible"
    );

    setText(
        "ema-slow-note",
        Number.isFinite(ema200)
            ? (price > ema200 ? "Prix au-dessus" : "Prix en dessous")
            : "200 bougies nécessaires"
    );

    setText(
        "rsi-value",
        Number.isFinite(rsi) ? formatNumber(rsi, 3) : "Indisponible"
    );

    let rsiNote = "Indisponible";

    if (Number.isFinite(rsi)) {
        if (rsi >= 70) rsiNote = "Surachat";
        else if (rsi <= 30) rsiNote = "Survente";
        else if (rsi > 50) rsiNote = "Momentum haussier";
        else if (rsi < 50) rsiNote = "Momentum baissier";
        else rsiNote = "Zone intermédiaire";
    }

    setText("rsi-note", rsiNote);

    setText(
        "atr-value",
        Number.isFinite(atr) ? formatPrice(atr) : "Indisponible"
    );
}

function determineTrend(ema50, price, rsi) {
    if (
        !Number.isFinite(ema50) ||
        !Number.isFinite(price) ||
        !Number.isFinite(rsi)
    ) {
        return "Indéterminée";
    }

    if (price > ema50 && rsi > 50) return "Haussière";
    if (price < ema50 && rsi < 50) return "Baissière";

    return "Neutre";
}

function generateSignal(data) {
    const {
        price,
        ema50,
        ema200,
        rsi,
        atr,
        previousClose,
        lastClose
    } = data;

    if (
        !Number.isFinite(ema50) ||
        !Number.isFinite(rsi) ||
        !Number.isFinite(atr) ||
        atr <= 0
    ) {
        return {
            type: "WAIT",
            reason: "Indicateurs insuffisants pour établir un signal fiable."
        };
    }

    const bullishCandle = lastClose > previousClose;
    const bearishCandle = lastClose < previousClose;
    const ema200Available = Number.isFinite(ema200);

    const buyCondition =
        price > ema50 &&
        rsi >= 50 &&
        rsi <= 68 &&
        bullishCandle &&
        (!ema200Available || price > ema200);

    const sellCondition =
        price < ema50 &&
        rsi >= 32 &&
        rsi <= 50 &&
        bearishCandle &&
        (!ema200Available || price < ema200);

    if (buyCondition) {
        const entry = price;
        const stopLoss = entry - atr * CONFIG.ATR_STOP_MULTIPLIER;
        const takeProfit = entry +
            (entry - stopLoss) * CONFIG.RISK_REWARD;

        return {
            type: "BUY",
            reason: ema200Available
                ? "Conditions haussières réunies."
                : "ACHAT provisoire : EMA 50, RSI et bougie haussière concordent. EMA 200 indisponible.",
            entry,
            stopLoss,
            takeProfit,
            riskReward: CONFIG.RISK_REWARD
        };
    }

    if (sellCondition) {
        const entry = price;
        const stopLoss = entry + atr * CONFIG.ATR_STOP_MULTIPLIER;
        const takeProfit = entry -
            (stopLoss - entry) * CONFIG.RISK_REWARD;

        return {
            type: "SELL",
            reason: ema200Available
                ? "Conditions baissières réunies."
                : "VENTE provisoire : EMA 50, RSI et bougie baissière concordent. EMA 200 indisponible.",
            entry,
            stopLoss,
            takeProfit,
            riskReward: CONFIG.RISK_REWARD
        };
    }

    return {
        type: "WAIT",
        reason: ema200Available
            ? "Les conditions d'entrée ne sont pas réunies."
            : "Aucun signal clair pour le moment. EMA 200 indisponible."
    };
}

function displaySignal(signal) {
    const badge = el("signal-badge");

    const labels = {
        BUY: "ACHAT (BUY)",
        SELL: "VENTE (SELL)",
        WAIT: "ATTENDRE"
    };

    setText("signal-badge", labels[signal.type] || "ATTENDRE");
    setText("signal-reason", signal.reason);

    if (badge) {
        badge.classList.remove("buy", "sell", "wait");

        if (signal.type === "BUY") badge.classList.add("buy");
        else if (signal.type === "SELL") badge.classList.add("sell");
        else badge.classList.add("wait");
    }

    setText(
        "entry-price",
        Number.isFinite(signal.entry) ? formatPrice(signal.entry) : "—"
    );

    setText(
        "stop-loss",
        Number.isFinite(signal.stopLoss) ? formatPrice(signal.stopLoss) : "—"
    );

    setText(
        "take-profit",
        Number.isFinite(signal.takeProfit) ? formatPrice(signal.takeProfit) : "—"
    );

    setText(
        "risk-reward",
        Number.isFinite(signal.riskReward)
            ? "1:" + formatNumber(signal.riskReward, 1)
            : "—"
    );
}

function analyzeMarket(candles, quote) {
    const closes = candles.map(candle => candle.close);

    const ema50Series = calculateEMA(closes, CONFIG.EMA_FAST);
    const ema200Series = calculateEMA(closes, CONFIG.EMA_SLOW);
    const rsiSeries = calculateRSI(closes, CONFIG.RSI_PERIOD);
    const atrSeries = calculateATR(candles, CONFIG.ATR_PERIOD);

    const lastIndex = candles.length - 1;

    const ema50 = ema50Series[lastIndex];
    const ema200 = ema200Series[lastIndex];
    const rsi = rsiSeries[lastIndex];
    const atr = atrSeries[lastIndex];

    const lastCandle = candles[lastIndex];
    const previousCandle = candles[lastIndex - 1];

    displayIndicators({
        ema50,
        ema200,
        rsi,
        atr,
        price: quote.mid
    });

    setText("bars-count", String(candles.length));

    setText(
        "last-candle",
        new Date(lastCandle.time).toLocaleString("fr-FR", {
            timeZone: "UTC",
            hour12: false
        }) + " UTC"
    );

    setText(
        "trend-value",
        determineTrend(ema50, quote.mid, rsi)
    );

    const signal = generateSignal({
        price: quote.mid,
        ema50,
        ema200,
        rsi,
        atr,
        previousClose: previousCandle.close,
        lastClose: lastCandle.close
    });

    displaySignal(signal);

    return {
        ema200,
        candleCount: candles.length
    };
}

async function refreshData() {
    if (isRefreshing) return;

    isRefreshing = true;

    const button = el("refresh-button");

    if (button) {
        button.disabled = true;
        button.textContent = "Actualisation...";
    }

    try {
        const results = await Promise.allSettled([
            fetchJSON(CONFIG.PRICE_URL),
            fetchJSON(CONFIG.CANDLES_URL)
        ]);

        let quote = null;
        let candles = null;

        if (results[0].status === "fulfilled") {
            try {
                quote = validateQuote(results[0].value);
                displayQuote(quote);
            } catch (error) {
                showError("Prix : " + error.message);
            }
        } else {
            showError(
                "Impossible de récupérer le prix : " +
                results[0].reason.message
            );
        }

        if (results[1].status === "fulfilled") {
            try {
                candles = normalizeCandles(results[1].value);
            } catch (error) {
                showError("Historique : " + error.message);
            }
        } else {
            showError(
                "Impossible de récupérer les bougies : " +
                results[1].reason.message
            );
        }

        if (quote && candles) {
            const result = analyzeMarket(candles, quote);

            if (!Number.isFinite(result.ema200)) {
                showError(
                    "Analyse effectuée avec " + result.candleCount +
                    " bougies H1. EMA 200 indisponible. " +
                    "Le signal éventuel est provisoire."
                );
            } else {
                hideError();
            }
        } else {
            displaySignal({
                type: "WAIT",
                reason: "Données insuffisantes. Vérifie la connexion à Biquote."
            });
        }
    } catch (error) {
        console.error(error);
        showError("Erreur d'analyse : " + error.message);
    } finally {
        isRefreshing = false;

        if (button) {
            button.disabled = false;
            button.textContent = "Actualiser maintenant";
        }

        countdown = CONFIG.REFRESH_INTERVAL;
        setText("countdown", String(countdown));
    }
}

function initializeDashboard() {
    const button = el("refresh-button");

    if (button) {
        button.addEventListener("click", refreshData);
    }

    setConnectionStatus(false, "Connexion...");
    setText("signal-badge", "ANALYSE EN COURS");

    refreshData();
}

setInterval(() => {
    countdown--;

    if (countdown <= 0) {
        countdown = CONFIG.REFRESH_INTERVAL;
        refreshData();
    }

    setText("countdown", String(countdown));
}, 1000);

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeDashboard);
} else {
    initializeDashboard();
                      }
