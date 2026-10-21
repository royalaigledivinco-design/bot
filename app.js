"use strict";

// =============================================
// 1. CONFIGURATION
// =============================================

const CONFIG = {
    PRICE_URL:
        "https://biquote.io/api/XAUUSD?allowStale=false",

    CANDLES_URL:
        "https://biquote.io/api/XAUUSD/ohlc?interval=1h&limit=500",

    REFRESH_INTERVAL: 60_000,

    EMA_FAST: 50,
    EMA_SLOW: 200,
    RSI_PERIOD: 14,
    ATR_PERIOD: 14,

    SL_ATR_MULTIPLIER: 1.5,
    TP_ATR_MULTIPLIER: 2.0
};

let refreshing = false;
let countdown = 60;


// =============================================
// 2. OUTILS
// =============================================

const $ = id => document.getElementById(id);

function formatPrice(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "—";
    }

    return number.toLocaleString("fr-FR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
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
    $("connection-status").textContent = message;
    $("status-dot").className = type;
}

function showError(message) {
    $("error-panel").hidden = false;
    $("error-message").textContent = message;

    setStatus("Données indisponibles", "error");
}

function hideError() {
    $("error-panel").hidden = true;
}


// =============================================
// 3. CONNEXION À BIQUOTE
// =============================================

async function fetchJSON(url) {
    const response = await fetch(url, {
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(
            `Erreur HTTP ${response.status} lors de la récupération des données.`
        );
    }

    return response.json();
}


// =============================================
// 4. CALCUL EMA
// =============================================

function calculateEMA(values, period) {
    if (values.length < period) {
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


// =============================================
// 5. CALCUL RSI
// =============================================

function calculateRSI(values, period = 14) {
    if (values.length <= period) {
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


// =============================================
// 6. CALCUL ATR
// =============================================

function calculateATR(bars, period = 14) {
    if (bars.length < period + 1) {
        return null;
    }

    const trueRanges = [];

    for (let i = 1; i < bars.length; i++) {
        const current = bars[i];
        const previous = bars[i - 1];

        const high = current.high;
        const low = current.low;
        const previousClose = previous.close;

        const trueRange = Math.max(
            high - low,
            Math.abs(high - previousClose),
            Math.abs(low - previousClose)
        );

        trueRanges.push(trueRange);
    }

    if (trueRanges.length < period) {
        return null;
    }

    let value =
        trueRanges.slice(0, period).reduce(
            (sum, item) => sum + item,
            0
        ) / period;

    for (let i = period; i < trueRanges.length; i++) {
        value =
            (value * (period - 1) + trueRanges[i]) / period;
    }

    return value;
}


// =============================================
// 7. AFFICHER LE SIGNAL
// =============================================

function displaySignal(
    type,
    reason,
    entry = null,
    stopLoss = null,
    takeProfit = null
) {
    const badge = $("signal-badge");

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

    $("signal-reason").textContent = reason;

    $("entry-price").textContent =
        entry === null ? "—" : formatPrice(entry);

    $("stop-loss").textContent =
        stopLoss === null ? "—" : formatPrice(stopLoss);

    $("take-profit").textContent =
        takeProfit === null ? "—" : formatPrice(takeProfit);

    $("risk-reward").textContent =
        entry === null ? "—" : "1 : " +
        formatPrice(
            CONFIG.TP_ATR_MULTIPLIER /
            CONFIG.SL_ATR_MULTIPLIER
        );
}


// =============================================
// 8. NORMALISER LES BOUGIES
// =============================================

function normalizeCandles(data) {
    if (!data || !Array.isArray(data.bars)) {
        throw new Error(
            "Format des bougies incorrect. Vérifie la réponse de l'API Biquote."
        );
    }

    const bars = data.bars
        .filter(bar => bar && bar.isOpen !== true)
        .map(bar => ({
            openTime: new Date(bar.openTime).getTime(),
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close)
        }))
        .filter(bar =>
            Number.isFinite(bar.openTime) &&
            Number.isFinite(bar.open) &&
            Number.isFinite(bar.high) &&
            Number.isFinite(bar.low) &&
            Number.isFinite(bar.close)
        )
        .sort((a, b) => a.openTime - b.openTime);

    if (bars.length < 220) {
        throw new Error(
            `Seulement ${bars.length} bougies H1 valides reçues. ` +
            "Au moins 220 sont nécessaires pour calculer l'EMA 200."
        );
    }

    return bars;
}


// =============================================
// 9. ANALYSER LE MARCHÉ
// =============================================

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
            "Impossible de calculer correctement les indicateurs."
        );
    }

    // Cotation Biquote attendue : bid, ask et mid.
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    const mid = Number(quote.mid);

    if (
        !Number.isFinite(bid) ||
        !Number.isFinite(ask) ||
        !Number.isFinite(mid) ||
        bid <= 0 ||
        ask <= 0 ||
        mid <= 0
    ) {
        throw new Error(
            "La cotation Biquote ne contient pas de bid, ask et mid valides."
        );
    }

    // Afficher les données reçues.
    $("current-price").textContent = formatPrice(mid);

    const dayChange = Number(quote.dayDiffPercent);

    $("price-change").textContent =
        Number.isFinite(dayChange)
            ? `${dayChange >= 0 ? "+" : ""}${formatPrice(dayChange)} %`
            : "";

    $("market-state").textContent =
        quote.marketState === "open"
            ? "Marché ouvert"
            : quote.marketState === "closed"
                ? "Marché fermé"
                : "État non communiqué";

    $("ema-fast").textContent = formatPrice(ema50);
    $("ema-slow").textContent = formatPrice(ema200);
    $("rsi-value").textContent = formatPrice(rsi);
    $("atr-value").textContent = formatPrice(atr);

    $("ema-fast-note").textContent =
        ema50 > ema200
            ? "Au-dessus de l'EMA 200"
            : ema50 < ema200
                ? "En dessous de l'EMA 200"
                : "Moyennes égales";

    $("ema-slow-note").textContent = "Tendance de fond";

    $("rsi-note").textContent =
        rsi >= 70
            ? "Surachat"
            : rsi <= 30
                ? "Survente"
                : "Zone intermédiaire";

    $("trend-value").textContent =
        ema50 > ema200
            ? "Haussière"
            : ema50 < ema200
                ? "Baissière"
                : "Neutre";

    $("last-candle").textContent =
        formatTime(bars[lastIndex].openTime);

    $("bars-count").textContent = String(bars.length);

    // Neutraliser les signaux en cas de cotation trop ancienne.
    const timestamp = quote.timestamp
        ? new Date(quote.timestamp).getTime()
        : NaN;

    const quoteAge = Number(quote.quoteAgeSeconds);

    const stale =
        quote.stale === true ||
        (Number.isFinite(quoteAge) && quoteAge > 300) ||
        (
            Number.isFinite(timestamp) &&
            Date.now() - timestamp > 300000
        );

    if (stale) {
        displaySignal(
            "WAIT",
            "Cotation trop ancienne : attends une mise à jour fiable."
        );

        $("market-state").textContent = "Cotation périmée";

        throw new Error(
            "La cotation XAUUSD est trop ancienne. Le signal est neutralisé."
        );
    }

    // Ne pas produire de signal si le marché est déclaré fermé.
    if (quote.marketState === "closed") {
        displaySignal(
            "WAIT",
            "Le marché est déclaré fermé par la source de données."
        );

        return;
    }

    const stopDistance =
        atr * CONFIG.SL_ATR_MULTIPLIER;

    const targetDistance =
        atr * CONFIG.TP_ATR_MULTIPLIER;

    // ACHAT : tendance haussière et RSI favorable.
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

    // VENTE : tendance baissière et RSI favorable.
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

    displaySignal(
        "WAIT",
        "Les conditions de la stratégie ne sont pas réunies. Attends une configuration plus claire."
    );
}


// =============================================
// 10. ACTUALISATION AUTOMATIQUE
// =============================================

async function refreshData() {
    if (refreshing) {
        return;
    }

    refreshing = true;

    $("refresh-button").disabled = true;

    setStatus("Actualisation...");

    try {
        const [quote, candlesData] = await Promise.all([
            fetchJSON(CONFIG.PRICE_URL),
            fetchJSON(CONFIG.CANDLES_URL)
        ]);

        if (
            quote.symbol &&
            quote.symbol !== "XAUUSD"
        ) {
            throw new Error(
                "La source a renvoyé un symbole différent de XAUUSD."
            );
        }

        analyzeMarket(candlesData, quote);

        hideError();

        $("last-update").textContent =
            new Date().toLocaleTimeString("fr-FR");

        setStatus("Connecté à Biquote", "ok");

    } catch (error) {
        showError(
            error instanceof Error
                ? error.message
                : "Une erreur inconnue est survenue."
        );

    } finally {
        refreshing = false;

        $("refresh-button").disabled = false;

        countdown = 60;
        $("countdown").textContent = "60";
    }
}


// =============================================
// 11. DÉMARRAGE
// =============================================

$("refresh-button").addEventListener(
    "click",
    refreshData
);

refreshData();

setInterval(
    refreshData,
    CONFIG.REFRESH_INTERVAL
);

setInterval(() => {
    countdown = Math.max(0, countdown - 1);

    $("countdown").textContent =
        String(countdown);
}, 1000);
