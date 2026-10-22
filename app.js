"use strict";

// ==================================================
// 1. CONFIGURATION
// ==================================================

const CONFIG = {
PRICE_URL: "https://biquote.io/api/XAUUSD?allowStale=false",
CANDLES_URL: "https://biquote.io/api/XAUUSD/ohlc?interval=1h&limit=500",

EMA_PERIOD: 50,
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
let timerStarted = false;
let refreshTimer = null;

// ==================================================
// 2. OUTILS D'AFFICHAGE
// ==================================================

function el(id) {
return document.getElementById(id);
}

function setText(id, value) {
const element = el(id);

if (element) {
    element.textContent = String(value);
}

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

// ==================================================
// 3. REQUÊTES API
// ==================================================

async function fetchJSON(url) {
const controller = new AbortController();

const timeout = setTimeout(() => {
    controller.abort();
}, CONFIG.FETCH_TIMEOUT);

try {
    const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
            Accept: "application/json"
        },
        signal: controller.signal
    });

    if (!response.ok) {
        throw new Error("Erreur HTTP " + response.status);
    }

    return await response.json();

} catch (error) {
    if (error.name === "AbortError") {
        throw new Error(
            "Délai dépassé : Biquote n'a pas répondu en 15 secondes."
        );
    }

    if (
        error instanceof TypeError ||
        error.name === "NetworkError"
    ) {
        throw new Error(
            "Connexion impossible. Vérifie Internet, l'API Biquote et les autorisations CORS."
        );
    }

    throw error;

} finally {
    clearTimeout(timeout);
}

}

// ==================================================
// 4. VALIDATION DU PRIX
// ==================================================

function validateQuote(data) {
if (!data || typeof data !== "object") {
throw new Error("Réponse de prix invalide.");
}

const bid = Number(data.bid);
const ask = Number(data.ask);

let mid = Number(data.mid);

if (!Number.isFinite(mid) || mid <= 0) {
    mid = (bid + ask) / 2;
}

if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    !Number.isFinite(mid) ||
    bid <= 0 ||
    ask < bid
) {
    throw new Error("Les prix reçus sont invalides.");
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

// ==================================================
// 5. AFFICHAGE DU PRIX
// ==================================================

function displayQuote(quote) {
setText("current-price", formatPrice(quote.mid));

if (Number.isFinite(quote.dayDiffPercent)) {
    const change = quote.dayDiffPercent;

    setText(
        "price-change",
        (change > 0 ? "+" : "") +
        formatNumber(change, 3) +
        " %"
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

setText(
    "market-state",
    states[quote.marketState] || quote.marketState
);

setText(
    "last-update",
    new Date().toLocaleTimeString("fr-FR", {
        hour12: false
    })
);

setConnectionStatus(true, "Prix reçu de Biquote");

}

// ==================================================
// 6. NORMALISATION DES BOUGIES H1
// ==================================================

function normalizeCandles(response) {
let bars = Array.isArray(response)
? response
: response && (
response.bars ||
response.candles ||
response.data
);

if (!Array.isArray(bars)) {
    throw new Error(
        "Format des bougies inconnu : vérifie la réponse de l'API Biquote."
    );
}

const candles = bars
    .filter(bar =>
        bar &&
        bar.openTime !== undefined &&
        bar.openTime !== null &&
        bar.isOpen !== true
    )
    .map(bar => {
        let timestamp;

        if (typeof bar.openTime === "number") {
            timestamp = bar.openTime;

            if (timestamp > 0 && timestamp < 100000000000) {
                timestamp *= 1000;
            }
        } else {
            timestamp = new Date(bar.openTime).getTime();
        }

        return {
            time: timestamp,
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close)
        };
    })
    .filter(c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.open > 0 &&
        c.high >= c.low &&
        c.close > 0 &&
        c.high >= Math.max(c.open, c.close) &&
        c.low <= Math.min(c.open, c.close)
    )
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
        " bougies H1 valides reçues. Au moins " +
        CONFIG.MIN_CANDLES + " sont nécessaires."
    );
}

return unique;

}

// ==================================================
// 7. CALCUL DE L'EMA 50
// ==================================================

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
    ema =
        values[i] * multiplier +
        ema * (1 - multiplier);

    result[i] = ema;
}

return result;

}

// ==================================================
// 8. CALCUL DU RSI 14
// ==================================================

function calculateRSI(values, period = 14) {
const result = new Array(values.length).fill(null);

if (values.length <= period) return result;

let gains = 0;
let losses = 0;

for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
        gains += change;
    } else {
        losses += Math.abs(change);
    }
}

let averageGain = gains / period;
let averageLoss = losses / period;

function rsiValue(gain, loss) {
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;

    return 100 - 100 / (1 + gain / loss);
}

result[period] = rsiValue(averageGain, averageLoss);

for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain =
        (averageGain * (period - 1) + gain) / period;

    averageLoss =
        (averageLoss * (period - 1) + loss) / period;

    result[i] = rsiValue(averageGain, averageLoss);
}

return result;

}

// ==================================================
// 9. CALCUL DE L'ATR 14
// ==================================================

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

    ranges.push(
        Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - previousClose),
            Math.abs(candle.low - previousClose)
        )
    );
}

let sum = 0;

for (let i = 0; i < period; i++) {
    sum += ranges[i];
}

let atr = sum / period;

result[period - 1] = atr;

for (let i = period; i < candles.length; i++) {
    atr =
        (atr * (period - 1) + ranges[i]) / period;

    result[i] = atr;
}

return result;

}

// ==================================================
// 10. AFFICHAGE DES INDICATEURS
// ==================================================

function displayIndicators(data) {
const { ema50, rsi, atr, price } = data;

setText(
    "ema-fast",
    Number.isFinite(ema50) ? formatPrice(ema50) : "Indisponible"
);

setText(
    "ema-fast-note",
    Number.isFinite(ema50)
        ? (
            price > ema50
                ? "Prix au-dessus"
                : price < ema50
                    ? "Prix en dessous"
                    : "Prix sur l'EMA 50"
        )
        : "Historique insuffisant"
);

setText(
    "rsi-value",
    Number.isFinite(rsi) ? formatNumber(rsi, 2) : "Indisponible"
);

let rsiNote = "Indisponible";

if (Number.isFinite(rsi)) {
    if (rsi >= 70) {
        rsiNote = "Surachat";
    } else if (rsi <= 30) {
        rsiNote = "Survente";
    } else if (rsi > 50) {
        rsiNote = "Momentum haussier";
    } else if (rsi < 50) {
        rsiNote = "Momentum baissier";
    } else {
        rsiNote = "Zone intermédiaire";
    }
}

setText("rsi-note", rsiNote);

setText(
    "atr-value",
    Number.isFinite(atr) ? formatPrice(atr) : "Indisponible"
);

}

// ==================================================
// 11. DÉTERMINATION DE LA TENDANCE
// ==================================================

function determineTrend(ema50, price, rsi) {
if (
!Number.isFinite(ema50) ||
!Number.isFinite(price) ||
!Number.isFinite(rsi)
) {
return "Indéterminée";
}

if (price > ema50 && rsi >= 50) return "Haussière";
if (price < ema50 && rsi < 50) return "Baissière";

if (price > ema50) return "Haussière";
if (price < ema50) return "Baissière";

return "Neutre";

}

// ==================================================
// 12. GÉNÉRATION DES SIGNAUX
// LOGIQUE SIMPLIFIÉE POUR PLUS DE SIGNAUX
// ==================================================

function generateSignal(data) {
const { price, ema50, rsi, atr } = data;

if (
    !Number.isFinite(price) ||
    !Number.isFinite(ema50) ||
    !Number.isFinite(rsi) ||
    !Number.isFinite(atr) ||
    price <= 0 ||
    ema50 <= 0 ||
    atr <= 0
) {
    return {
        type: "WAIT",
        reason: "Données insuffisantes pour calculer un signal fiable."
    };
}

let direction = null;
let reason = "";

// ACHAT : prix au-dessus de l'EMA 50.
// Le RSI ne doit pas être en zone de surachat extrême.
if (price > ema50 && rsi >= 50 && rsi < 80) {
    direction = "BUY";

    reason =
        "ACHAT : prix au-dessus de l'EMA 50 et RSI indiquant un momentum haussier.";
}

// VENTE : prix sous l'EMA 50.
// Le RSI ne doit pas être en zone de survente extrême.
else if (price < ema50 && rsi <= 50 && rsi > 20) {
    direction = "SELL";

    reason =
        "VENTE : prix sous l'EMA 50 et RSI indiquant un momentum baissier.";
}

// Si l'EMA et le RSI ne donnent pas la même direction,
// on utilise la position du prix par rapport à l'EMA.
else if (price > ema50 && rsi >= 40 && rsi < 50) {
    direction = "BUY";

    reason =
        "ACHAT : prix au-dessus de l'EMA 50. Le RSI reste faible ; signal à surveiller.";
}

else if (price < ema50 && rsi > 50 && rsi <= 60) {
    direction = "SELL";

    reason =
        "VENTE : prix sous l'EMA 50. Le RSI reste élevé ; signal à surveiller.";
}

if (!direction) {
    return {
        type: "WAIT",
        reason:
            "Le prix se trouve près de l'EMA 50 ou les indicateurs sont contradictoires. Attends une meilleure configuration."
    };
}

const entry = price;
const risk = atr * CONFIG.ATR_STOP_MULTIPLIER;

if (!Number.isFinite(risk) || risk <= 0) {
    return {
        type: "WAIT",
        reason: "Impossible de calculer le risque à partir de l'ATR."
    };
}

let stopLoss;
let takeProfit;

if (direction === "BUY") {
    stopLoss = entry - risk;
    takeProfit = entry + risk * CONFIG.RISK_REWARD;
} else {
    stopLoss = entry + risk;
    takeProfit = entry - risk * CONFIG.RISK_REWARD;
}

return {
    type: direction,
    reason,
    entry,
    stopLoss,
    takeProfit,
    riskReward: CONFIG.RISK_REWARD
};

}

// ==================================================
// 13. AFFICHAGE DU SIGNAL
// ==================================================

function displaySignal(signal) {
const badge = el("signal-badge");

const labels = {
    BUY: "ACHAT (BUY)",
    SELL: "VENTE (SELL)",
    WAIT: "ATTENDRE"
};

setText(
    "signal-badge",
    labels[signal.type] || "ATTENDRE"
);

setText("signal-reason", signal.reason);

if (badge) {
    badge.classList.remove("buy", "sell", "wait");

    if (signal.type === "BUY") {
        badge.classList.add("buy");
    } else if (signal.type === "SELL") {
        badge.classList.add("sell");
    } else {
        badge.classList.add("wait");
    }
}

setText(
    "entry-price",
    Number.isFinite(signal.entry)
        ? formatPrice(signal.entry)
        : "—"
);

setText(
    "stop-loss",
    Number.isFinite(signal.stopLoss)
        ? formatPrice(signal.stopLoss)
        : "—"
);

setText(
    "take-profit",
    Number.isFinite(signal.takeProfit)
        ? formatPrice(signal.takeProfit)
        : "—"
);

setText(
    "risk-reward",
    Number.isFinite(signal.riskReward)
        ? "1:" + formatNumber(signal.riskReward, 1)
        : "—"
);

}

// ==================================================
// 14. ANALYSE DU MARCHÉ H1
// ==================================================

function analyzeMarket(candles, quote) {
const closes = candles.map(candle => candle.close);

const ema50Series = calculateEMA(
    closes,
    CONFIG.EMA_PERIOD
);

const rsiSeries = calculateRSI(
    closes,
    CONFIG.RSI_PERIOD
);

const atrSeries = calculateATR(
    candles,
    CONFIG.ATR_PERIOD
);

const lastIndex = candles.length - 1;

const ema50 = ema50Series[lastIndex];
const rsi = rsiSeries[lastIndex];
const atr = atrSeries[lastIndex];

const lastCandle = candles[lastIndex];

displayIndicators({
    ema50,
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

// La dernière bougie n'est plus une condition obligatoire
// pour générer un signal.
const signal = generateSignal({
    price: quote.mid,
    ema50,
    rsi,
    atr
});

displaySignal(signal);

return {
    candleCount: candles.length,
    signalType: signal.type
};

}

// ==================================================
// 15. ACTUALISATION DU TABLEAU DE BORD
// ==================================================

async function refreshData() {
if (isRefreshing) return;

isRefreshing = true;

const button = el("refresh-button");

if (button) {
    button.disabled = true;
    button.textContent = "Actualisation...";
}

hideError();

try {
    const results = await Promise.allSettled([
        fetchJSON(CONFIG.PRICE_URL),
        fetchJSON(CONFIG.CANDLES_URL)
    ]);

    let quote = null;
    let candles = null;
    let quoteError = null;
    let candlesError = null;

    if (results[0].status === "fulfilled") {
        try {
            quote = validateQuote(results[0].value);
            displayQuote(quote);
        } catch (error) {
            quoteError = error.message;
        }
    } else {
        quoteError = results[0].reason
            ? results[0].reason.message
            : "Erreur inconnue lors de la récupération du prix.";
    }

    if (results[1].status === "fulfilled") {
        try {
            candles = normalizeCandles(results[1].value);
        } catch (error) {
            candlesError = error.message;
        }
    } else {
        candlesError = results[1].reason
            ? results[1].reason.message
            : "Erreur inconnue lors de la récupération des bougies.";
    }

    const messages = [];

    if (quoteError) {
        messages.push("Prix : " + quoteError);
    }

    if (candlesError) {
        messages.push("Historique : " + candlesError);
    }

    if (messages.length > 0) {
        showError(messages.join(" | "));
    }

    if (quote && candles) {
        analyzeMarket(candles, quote);

        setConnectionStatus(
            true,
            "Données reçues de Biquote"
        );
    } else {
        displaySignal({
            type: "WAIT",
            reason:
                "Analyse incomplète : vérifie les données et la connexion à Biquote."
        });

        setConnectionStatus(
            false,
            "Données indisponibles"
        );
    }

} catch (error) {
    console.error("Erreur d'actualisation :", error);

    showError("Erreur d'analyse : " + error.message);

    setConnectionStatus(false, "Erreur de connexion");

    displaySignal({
        type: "WAIT",
        reason:
            "Impossible de terminer l'analyse. Vérifie le message d'erreur."
    });

} finally {
    isRefreshing = false;

    if (button) {
        button.disabled = false;
        button.textContent = "Actualiser maintenant";
    }

    countdown = CONFIG.REFRESH_INTERVAL;
    setText("countdown", countdown);
}

}

// ==================================================
// 16. INITIALISATION
// ==================================================

function initializeDashboard() {
const button = el("refresh-button");

if (button) {
    button.addEventListener("click", refreshData);
}

setConnectionStatus(false, "Connexion à Biquote...");

displaySignal({
    type: "WAIT",
    reason: "Récupération des données du marché..."
});

refreshData();

if (!timerStarted) {
    timerStarted = true;

    refreshTimer = setInterval(() => {
        countdown--;

        if (countdown <= 0) {
            countdown = CONFIG.REFRESH_INTERVAL;
            refreshData();
        }

        setText("countdown", countdown);
    }, 1000);
}

}

// ==================================================
// 17. LANCEMENT
// ==================================================

if (document.readyState === "loading") {
document.addEventListener(
"DOMContentLoaded",
initializeDashboard,
{ once: true }
);
} else {
initializeDashboard();
    }
