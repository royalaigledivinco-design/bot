"use strict";

// ==================================================
// 1. CONFIGURATION
// ==================================================

const CONFIG = {
    PRICE_URL: "https://biquote.io/api/XAUUSD?allowStale=false",
    CANDLES_URL: "https://biquote.io/api/XAUUSD/ohlc?interval=1h&limit=500",

    REFRESH_INTERVAL: 60_000,

    EMA_FAST: 50,
    EMA_SLOW: 200,
    RSI_PERIOD: 14,
    ATR_PERIOD: 14,

    SL_ATR_MULTIPLIER: 1.5,
    TP_ATR_MULTIPLIER: 2.0,

    MAX_QUOTE_AGE_SECONDS: 300,

    // Nombre minimal pour calculer les indicateurs.
    MIN_CANDLES: 200
};

// ==================================================
// 2. ÉTAT DE L'APPLICATION
// ==================================================

let refreshing = false;
let countdown = 60;
let refreshTimer = null;
let countdownTimer = null;

// ==================================================
// 3. UTILITAIRES
// ==================================================

const $ = id => document.getElementById(id);

function setText(id, value) {
    const element = $(id);

    if (element) {
        element.textContent = value;
    }
}

function formatPrice(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "—";
    }

    return number.toLocaleString("fr-FR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 3
    });
}

function formatTime(value) {
    const date = new Date(value);

    if (!Number.isFinite(date.getTime())) {
        return "Indisponible";
    }

    return date.toLocaleString("fr-FR", {
        timeZone: "UTC",
        dateStyle: "short",
        timeStyle: "medium"
    }) + " UTC";
}

function setStatus(message, type = "") {
    setText("connection-status", message);

    const dot = $("status-dot");

    if (dot) {
        dot.className = type;
    }
}

function showError(message) {
    const panel = $("error-panel");

    if (panel) {
        panel.hidden = false;
    }

    setText("error-message", message);
}

function hideError() {
    const panel = $("error-panel");

    if (panel) {
        panel.hidden = true;
    }
}

function setLastUpdate() {
    setText(
        "last-update",
        new Date().toLocaleTimeString("fr-FR")
    );
}

async function fetchJSON(url) {
    const response = await fetch(url, {
        method: "GET",
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(
            `Erreur HTTP ${response.status} lors de la récupération des données.`
        );
    }

    return response.json();
}

// ==================================================
// 4. CALCUL DE L'EMA
// ==================================================

function calculateEMA(values, period) {
    if (!Array.isArray(values) || values.length < period) {
        return [];
    }

    const result = new Array(values.length).fill(null);

    let sum = 0;

    for (let i = 0; i < period; i++) {
        sum += values[i];
    }

    let previous = sum / period;

    result[period - 1] = previous;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {
        previous =
            (values[i] - previous) * multiplier + previous;

        result[i] = previous;
    }

    return result;
}

// ==================================================
// 5. CALCUL DU RSI
// ==================================================

function calculateRSI(values, period = 14) {
    if (!Array.isArray(values) || values.length <= period) {
        return null;
    }

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const difference = values[i] - values[i - 1];

        if (difference > 0) {
            gains += difference;
        } else {
            losses -= difference;
        }
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    for (let i = period + 1; i < values.length; i++) {
        const difference = values[i] - values[i - 1];

        const gain = Math.max(difference, 0);
        const loss = Math.max(-difference, 0);

        averageGain =
            (averageGain * (period - 1) + gain) / period;

        averageLoss =
            (averageLoss * (period - 1) + loss) / period;
    }

    if (averageLoss === 0) {
        return averageGain === 0 ? 50 : 100;
    }

    const relativeStrength = averageGain / averageLoss;

    return 100 - 100 / (1 + relativeStrength);
}

// ==================================================
// 6. CALCUL DE L'ATR
// ==================================================

function calculateATR(bars, period = 14) {
    if (!Array.isArray(bars) || bars.length < period + 1) {
        return null;
    }

    const trueRanges = [];

    for (let i = 1; i < bars.length; i++) {
        const current = bars[i];
        const previous = bars[i - 1];

        const trueRange = Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close)
        );

        trueRanges.push(trueRange);
    }

    if (trueRanges.length < period) {
        return null;
    }

    let atr = trueRanges
        .slice(0, period)
        .reduce((sum, value) => sum + value, 0) / period;

    for (let i = period; i < trueRanges.length; i++) {
        atr =
            (atr * (period - 1) + trueRanges[i]) / period;
    }

    return atr;
}

// ==================================================
// 7. NORMALISATION DES BOUGIES
// ==================================================

function normalizeCandles(data) {
    if (!data || !Array.isArray(data.bars)) {
        throw new Error(
            "Format des bougies incorrect. Vérifie la réponse de Biquote."
        );
    }

    const bars = data.bars
        .filter(bar => {
            if (!bar || bar.isOpen === true) {
                return false;
            }

            return true;
        })
        .map(bar => ({
            openTime: new Date(bar.openTime).getTime(),
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close)
        }))
        .filter(bar => {
            return (
                Number.isFinite(bar.openTime) &&
                Number.isFinite(bar.open) &&
                Number.isFinite(bar.high) &&
                Number.isFinite(bar.low) &&
                Number.isFinite(bar.close) &&
                bar.open > 0 &&
                bar.high > 0 &&
                bar.low > 0 &&
                bar.close > 0 &&
                bar.high >= bar.low
            );
        });

    // L'API renvoie les bougies les plus récentes en premier.
    // Les indicateurs doivent être calculés chronologiquement.
    bars.sort((a, b) => a.openTime - b.openTime);

    // Élimination des doublons de bougies.
    const uniqueBars = [];

    for (const bar of bars) {
        const previous = uniqueBars[uniqueBars.length - 1];

        if (!previous || previous.openTime !== bar.openTime) {
            uniqueBars.push(bar);
        }
    }

    if (uniqueBars.length < CONFIG.MIN_CANDLES) {
        throw new Error(
            `Historique insuffisant : ${uniqueBars.length} bougies H1 valides reçues. ` +
            `Il en faut au moins ${CONFIG.MIN_CANDLES} pour calculer correctement l'EMA 200. ` +
            `Le paramètre limit=500 ne garantit pas que l'API fournisse 500 bougies.`
        );
    }

    return uniqueBars;
}

// ==================================================
// 8. AFFICHAGE DU SIGNAL
// ==================================================

function displaySignal(
    type,
    reason,
    entry = null,
    stopLoss = null,
    takeProfit = null
) {
    const badge = $("signal-badge");

    if (badge) {
        badge.className = "signal-badge";

        if (type === "BUY") {
            badge.classList.add("buy");
            badge.textContent = "ACHAT";
        } else if (type === "SELL") {
            badge.classList.add("sell");
            badge.textContent = "VENTE";
        } else {
            badge.classList.add("wait");
            badge.textContent = "ATTENDRE";
        }
    }

    setText("signal-reason", reason);

    setText(
        "entry-price",
        entry === null ? "—" : formatPrice(entry)
    );

    setText(
        "stop-loss",
        stopLoss === null ? "—" : formatPrice(stopLoss)
    );

    setText(
        "take-profit",
        takeProfit === null ? "—" : formatPrice(takeProfit)
    );

    setText(
        "risk-reward",
        entry === null
            ? "—"
            : `1 : ${(
                CONFIG.TP_ATR_MULTIPLIER /
                CONFIG.SL_ATR_MULTIPLIER
            ).toFixed(2).replace(".", ",")}`
    );
}

// ==================================================
// 9. VALIDATION DE LA COTATION
// ==================================================

function validateQuote(quote) {
    if (!quote || typeof quote !== "object") {
        throw new Error("La cotation reçue est vide ou invalide.");
    }

    if (quote.symbol && quote.symbol !== "XAUUSD") {
        throw new Error(
            `Symbole inattendu : ${quote.symbol}. XAUUSD est attendu.`
        );
    }

    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    const mid = Number(quote.mid);

    if (
        !Number.isFinite(bid) ||
        !Number.isFinite(ask) ||
        bid <= 0 ||
        ask <= 0 ||
        ask < bid
    ) {
        throw new Error(
            "Les prix bid et ask de la cotation sont invalides."
        );
    }

    // Si mid est absent ou invalide, on calcule le milieu du spread.
    const validMid =
        Number.isFinite(mid) && mid > 0
            ? mid
            : (bid + ask) / 2;

    return {
        ...quote,
        bid,
        ask,
        mid: validMid
    };
}

// ==================================================
// 10. AFFICHAGE DES INFORMATIONS DU PRIX
// ==================================================

function displayQuote(quote) {
    setText("current-price", formatPrice(quote.mid));

    const dayChange = Number(quote.dayDiffPercent);

    setText(
        "price-change",
        Number.isFinite(dayChange)
            ? `${dayChange >= 0 ? "+" : ""}${dayChange.toLocaleString(
                "fr-FR",
                {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4
                }
            )} %`
            : "—"
    );

    let marketState = "État non communiqué";

    if (quote.marketState === "open") {
        marketState = "Marché ouvert";
    } else if (quote.marketState === "closed") {
        marketState = "Marché fermé";
    }

    setText("market-state", marketState);

    const spread = Number(quote.spread);

    if (Number.isFinite(spread)) {
        setText("spread-value", formatPrice(spread));
    }
}

// ==================================================
// 11. ANALYSE DU MARCHÉ
// ==================================================

function analyzeMarket(candlesData, quote) {
    const bars = normalizeCandles(candlesData);

    const closes = bars.map(bar => bar.close);

    const fastEMA = calculateEMA(
        closes,
        CONFIG.EMA_FAST
    );

    const slowEMA = calculateEMA(
        closes,
        CONFIG.EMA_SLOW
    );

    const lastIndex = closes.length - 1;

    const ema50 = fastEMA[lastIndex];
    const ema200 = slowEMA[lastIndex];

    const rsi = calculateRSI(
        closes,
        CONFIG.RSI_PERIOD
    );

    const atr = calculateATR(
        bars,
        CONFIG.ATR_PERIOD
    );

    if (
        !Number.isFinite(ema50) ||
        !Number.isFinite(ema200) ||
        !Number.isFinite(rsi) ||
        !Number.isFinite(atr) ||
        atr <= 0
    ) {
        throw new Error(
            "Impossible de calculer correctement les indicateurs techniques."
        );
    }

    setText("ema-fast", formatPrice(ema50));
    setText("ema-slow", formatPrice(ema200));
    setText("rsi-value", formatPrice(rsi));
    setText("atr-value", formatPrice(atr));

    setText(
        "ema-fast-note",
        ema50 > ema200
            ? "Au-dessus de l'EMA 200"
            : ema50 < ema200
                ? "En dessous de l'EMA 200"
                : "Moyennes égales"
    );

    setText("ema-slow-note", "Tendance de fond");

    setText(
        "rsi-note",
        rsi >= 70
            ? "Surachat"
            : rsi <= 30
                ? "Survente"
                : "Zone intermédiaire"
    );

    setText(
        "trend-value",
        ema50 > ema200
            ? "Haussière"
            : ema50 < ema200
                ? "Baissière"
                : "Neutre"
    );

    setText(
        "last-candle",
        formatTime(bars[lastIndex].openTime)
    );

    setText("bars-count", String(bars.length));

    // Vérification de l'âge de la cotation.
    const timestamp = quote.timestamp
        ? new Date(quote.timestamp).getTime()
        : NaN;

    const quoteAge = Number(quote.quoteAgeSeconds);

    const stale =
        quote.stale === true ||
        (
            Number.isFinite(quoteAge) &&
            quoteAge > CONFIG.MAX_QUOTE_AGE_SECONDS
        ) ||
        (
            Number.isFinite(timestamp) &&
            Date.now() - timestamp >
                CONFIG.MAX_QUOTE_AGE_SECONDS * 1000
        );

    if (stale) {
        displaySignal(
            "WAIT",
            "Cotation trop ancienne. Aucun signal exploitable."
        );

        setText("market-state", "Cotation périmée");

        throw new Error(
            "La cotation XAUUSD est trop ancienne. Le signal est neutralisé."
        );
    }

    if (quote.marketState === "closed") {
        displaySignal(
            "WAIT",
            "Le marché est déclaré fermé par la source de données."
        );

        return;
    }

    const bid = quote.bid;
    const ask = quote.ask;

    const stopDistance =
        atr * CONFIG.SL_ATR_MULTIPLIER;

    const targetDistance =
        atr * CONFIG.TP_ATR_MULTIPLIER;

    // Signal ACHAT.
    if (
        ema50 > ema200 &&
        rsi >= 50 &&
        rsi < 70
    ) {
        displaySignal(
            "BUY",
            "Tendance haussière : EMA 50 supérieure à EMA 200 et RSI favorable.",
            ask,
            ask - stopDistance,
            ask + targetDistance
        );

        return;
    }

    // Signal VENTE.
    if (
        ema50 < ema200 &&
        rsi <= 50 &&
        rsi > 30
    ) {
        displaySignal(
            "SELL",
            "Tendance baissière : EMA 50 inférieure à EMA 200 et RSI favorable.",
            bid,
            bid + stopDistance,
            bid - targetDistance
        );

        return;
    }

    // Aucun signal suffisamment clair.
    displaySignal(
        "WAIT",
        "Les conditions de la stratégie ne sont pas réunies. Attends une configuration plus claire."
    );
}

// ==================================================
// 12. ACTUALISATION DU TABLEAU DE BORD
// ==================================================

async function refreshData() {
    if (refreshing) {
        return;
    }

    refreshing = true;

    const refreshButton = $("refresh-button");

    if (refreshButton) {
        refreshButton.disabled = true;
    }

    setStatus("Actualisation...", "");

    try {
        // Récupération du prix et de l'historique en parallèle.
        const results = await Promise.allSettled([
            fetchJSON(CONFIG.PRICE_URL),
            fetchJSON(CONFIG.CANDLES_URL)
        ]);

        const quoteResult = results[0];
        const candlesResult = results[1];

        let validQuote = null;
        let quoteError = null;

        // Le prix peut s'afficher même si l'historique échoue.
        if (quoteResult.status === "fulfilled") {
            try {
                validQuote = validateQuote(quoteResult.value);

                displayQuote(validQuote);

                const quoteAge = Number(
                    validQuote.quoteAgeSeconds
                );

                const quoteIsStale =
                    validQuote.stale === true ||
                    (
                        Number.isFinite(quoteAge) &&
                        quoteAge > CONFIG.MAX_QUOTE_AGE_SECONDS
                    );

                if (quoteIsStale) {
                    displaySignal(
                        "WAIT",
                        "Cotation trop ancienne. Attends une cotation actualisée."
                    );
                }
            } catch (error) {
                quoteError = error;
            }
        } else {
            quoteError = quoteResult.reason;
        }

        // Si la cotation est invalide, on ne calcule aucun signal.
        if (!validQuote || quoteError) {
            displaySignal(
                "WAIT",
                "Cotation indisponible. Aucun nouveau signal ne peut être confirmé."
            );

            throw new Error(
                quoteError instanceof Error
                    ? quoteError.message
                    : "Impossible de récupérer la cotation XAUUSD."
            );
        }

        // Si le prix est ancien, aucun nouveau signal n'est autorisé.
        const quoteTimestamp = validQuote.timestamp
            ? new Date(validQuote.timestamp).getTime()
            : NaN;

        const quoteAge = Number(
            validQuote.quoteAgeSeconds
        );

        const quoteIsStale =
            validQuote.stale === true ||
            (
                Number.isFinite(quoteAge) &&
                quoteAge > CONFIG.MAX_QUOTE_AGE_SECONDS
            ) ||
            (
                Number.isFinite(quoteTimestamp) &&
                Date.now() - quoteTimestamp >
                    CONFIG.MAX_QUOTE_AGE_SECONDS * 1000
            );

        if (quoteIsStale) {
            displaySignal(
                "WAIT",
                "Cotation périmée : signal neutralisé."
            );

            throw new Error(
                "La cotation reçue est trop ancienne."
            );
        }

        if (candlesResult.status !== "fulfilled") {
            displaySignal(
                "WAIT",
                "Prix disponible, mais historique des bougies inaccessible."
            );

            throw new Error(
                "Impossible de récupérer les bougies H1. Vérifie la connexion à Biquote."
            );
        }

        // Analyse technique indépendante de l'affichage du prix.
        analyzeMarket(
            candlesResult.value,
            validQuote
        );

        hideError();

        setStatus("Connecté à Biquote", "ok");

        setLastUpdate();

    } catch (error) {
        showError(
            error instanceof Error
                ? error.message
                : "Une erreur inconnue est survenue."
        );

        setStatus("Données partiellement disponibles", "error");

    } finally {
        refreshing = false;

        if (refreshButton) {
            refreshButton.disabled = false;
        }

        countdown = 60;

        setText("countdown", "60");
    }
}

// ==================================================
// 13. INITIALISATION
// ==================================================

function initializeDashboard() {
    const refreshButton = $("refresh-button");

    if (refreshButton) {
        refreshButton.addEventListener(
            "click",
            refreshData
        );
    }

    refreshData();

    if (refreshTimer) {
        clearInterval(refreshTimer);
    }

    if (countdownTimer) {
        clearInterval(countdownTimer);
    }

    refreshTimer = setInterval(
        refreshData,
        CONFIG.REFRESH_INTERVAL
    );

    countdownTimer = setInterval(() => {
        countdown = Math.max(0, countdown - 1);

        setText("countdown", String(countdown));
    }, 1000);
}

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initializeDashboard,
        { once: true }
    );
} else {
    initializeDashboard();
        }
