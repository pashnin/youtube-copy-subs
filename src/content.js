(function () {
    "use strict";
    try {
        if (window.top !== window) return;
    } catch {
        return;
    }
    if (globalThis.__ytcCopyContent) return;
    globalThis.__ytcCopyContent = true;

    const {
        parseSubtitles,
        looksLikeHtml,
        isTimedtextUrl,
        buildTimedtextUrls,
        rankTracks,
    } = globalThis.YtcParse || {};

    const LABEL = "Скопировать субтитры";
    const MESSAGES = {
        ok: "Субтитры скопированы",
        ad: "Сейчас реклама. Дождитесь видео и нажмите ещё раз",
        "no-video": "Откройте страницу видео",
        player: "Плеер ещё не готов. Подождите пару секунд",
        hooks: "Обновите страницу и нажмите ещё раз",
        login: "Войдите в YouTube или подтвердите возраст и обновите страницу",
        unavailable: "Видео недоступно",
        "no-captions": "У этого видео нет субтитров",
        rate: "YouTube временно ограничил запросы. Подождите и повторите",
        empty: "Субтитры пустые",
        download: "Не удалось скачать субтитры",
        timeout: "Плеер не отдал субтитры. Попробуйте ещё раз",
        parse: "Не удалось разобрать субтитры",
        clipboard: "Не удалось скопировать в буфер",
        navigated: "Ролик сменился. Нажмите ещё раз",
        generic: "Не удалось скопировать субтитры",
    };

    class CopyError extends Error {
        constructor(code, detail) {
            super(code);
            this.name = "CopyError";
            this.code = code;
            this.detail = detail || null;
        }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const player = () => document.getElementById("movie_player");
    const queryPlayer = (selector) => player()?.querySelector(selector) || null;

    function currentVideoId() {
        const fromQuery = new URLSearchParams(location.search).get("v");
        if (fromQuery) return fromQuery;
        const embed = location.pathname.match(/^\/embed\/([^/?#]+)/);
        if (embed) return decodeURIComponent(embed[1]);
        return (
            document.querySelector("ytd-watch-flexy")?.getAttribute("video-id") ||
            null
        );
    }

    function isAd() {
        return player()?.classList.contains("ad-showing") === true;
    }

    function hooksReady() {
        return (
            document.documentElement.dataset.ytcPageHooks === "1" ||
            Boolean(document.querySelector("meta[name='ytc-page-hooks']"))
        );
    }

    function pageLanguage() {
        return document.documentElement.lang || navigator.language || "en";
    }

    function primary(code) {
        return String(code || "")
            .toLowerCase()
            .split("-")[0];
    }

    function sameLang(a, b) {
        const left = primary(a);
        const right = primary(b);
        return Boolean(left) && left === right;
    }

    function isOn(button) {
        if (!button) return false;
        return (
            button.getAttribute("aria-pressed") === "true" ||
            button.classList.contains("ytp-subtitles-active")
        );
    }

    function noTrackCode(status) {
        const value = String(status || "");
        if (/LOGIN|AGE|CHECK/.test(value)) return "login";
        if (value === "ERROR" || value === "UNPLAYABLE") return "unavailable";
        return "no-captions";
    }

    function formatError(err) {
        if (!(err instanceof CopyError)) return MESSAGES.generic;
        if (
            err.code === "download" &&
            err.detail?.status >= 400 &&
            err.detail.status <= 599
        ) {
            return `${MESSAGES.download} (HTTP ${err.detail.status})`;
        }
        return MESSAGES[err.code] || MESSAGES.generic;
    }

    const bodies = [];
    const lastPlayerUrl = new Map();
    let nextRequestId = 0;
    let busy = false;
    let toastEl = null;
    let toastTimer = 0;

    function looksTextual(body) {
        if (typeof looksLikeHtml === "function" && looksLikeHtml(body)) {
            return false;
        }
        const start = body.trimStart().slice(0, 16);
        return (
            start.startsWith("{") ||
            start.startsWith("[") ||
            start.startsWith("<") ||
            start.startsWith("WEBVTT")
        );
    }

    function isFresh(raw) {
        try {
            const expire = Number(new URL(raw).searchParams.get("expire"));
            if (!expire) return true;
            return expire * 1000 > Date.now() + 15000;
        } catch {
            return false;
        }
    }

    function remember(rawUrl, body) {
        if (typeof isTimedtextUrl !== "function" || !isTimedtextUrl(rawUrl)) {
            return;
        }
        let url;
        try {
            url = new URL(rawUrl, "https://www.youtube.com");
        } catch {
            return;
        }
        const videoId = url.searchParams.get("v");
        if (!videoId) return;
        if (isFresh(url.href)) lastPlayerUrl.set(videoId, url.href);
        if (typeof body !== "string" || !looksTextual(body)) return;
        bodies.push({
            videoId,
            lang: url.searchParams.get("lang") || "",
            kind: url.searchParams.get("kind") || "",
            body,
            at: Date.now(),
        });
        while (bodies.length > 12) bodies.shift();
    }

    window.addEventListener("message", (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.source !== "ytc-copy-page") return;
        if (data.type !== "subtitle-body") return;
        remember(data.url, data.body);
    });

    function callPage(type, payload, timeoutMs) {
        const requestId = ++nextRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                window.removeEventListener("message", onMessage);
                reject(new CopyError("timeout"));
            }, timeoutMs);
            function onMessage(event) {
                if (event.source !== window || event.origin !== location.origin) {
                    return;
                }
                const data = event.data;
                if (!data || data.source !== "ytc-copy-page") return;
                if (data.requestId !== requestId) return;
                clearTimeout(timer);
                window.removeEventListener("message", onMessage);
                resolve(data);
            }
            window.addEventListener("message", onMessage);
            window.postMessage(
                { source: "ytc-copy", type, requestId, ...payload },
                location.origin,
            );
        });
    }

    function bodiesFor(videoId) {
        return bodies.filter((entry) => entry.videoId === videoId);
    }

    function safeText(body, rolling) {
        if (typeof body !== "string" || !body.trim()) return "";
        if (typeof parseSubtitles !== "function") return "";
        try {
            return parseSubtitles(body, { rolling }) || "";
        } catch {
            return "";
        }
    }

    function textMatching(videoId, languageCode) {
        const list = bodiesFor(videoId);
        for (let i = list.length - 1; i >= 0; i -= 1) {
            if (!sameLang(list[i].lang, languageCode)) continue;
            const text = safeText(list[i].body, list[i].kind === "asr");
            if (text) return text;
        }
        return "";
    }

    function textAfter(videoId, since) {
        const list = bodiesFor(videoId);
        for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i].at < since) break;
            const text = safeText(list[i].body, list[i].kind === "asr");
            if (text) return text;
        }
        return "";
    }

    function newestText(videoId) {
        const list = bodiesFor(videoId);
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const text = safeText(list[i].body, list[i].kind === "asr");
            if (text) return text;
        }
        return "";
    }

    function assertSame(videoId) {
        if (currentVideoId() !== videoId) throw new CopyError("navigated");
    }

    async function loadSnapshot(videoId) {
        const deadline = Date.now() + 2000;
        let last = null;
        while (Date.now() <= deadline) {
            assertSame(videoId);
            const data = await callPage("player-response", {}, 800);
            last = data?.value || null;
            if (last?.videoId === videoId) return last;
            await sleep(200);
        }
        if (last?.videoId && last.videoId !== videoId) {
            throw new CopyError("navigated");
        }
        throw new CopyError("player");
    }

    async function fetchTimedtext(url) {
        let last = { ok: false, status: 0, body: "" };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const data = await callPage("fetch-timedtext", { url }, 12000);
            last = {
                ok: Boolean(data?.ok),
                status: Number(data?.status) || 0,
                body: typeof data?.body === "string" ? data.body : "",
            };
            if (last.ok || last.status === 429 || last.status !== 0 || attempt === 1) {
                return last;
            }
            await sleep(400);
        }
        return last;
    }

    async function fetchPreferred(track) {
        let urls;
        try {
            urls = buildTimedtextUrls(track.baseUrl);
        } catch {
            return { error: new CopyError("download") };
        }
        const rolling = track.kind === "asr";
        let empty = false;
        let garbage = false;
        let status = 0;
        for (const url of urls) {
            const result = await fetchTimedtext(url);
            if (result.status === 429) return { error: new CopyError("rate") };
            if (!result.ok) {
                if (result.status) status = result.status;
                continue;
            }
            const body = result.body || "";
            if (!body.trim()) {
                empty = true;
                continue;
            }
            if (typeof looksLikeHtml === "function" && looksLikeHtml(body)) {
                garbage = true;
                continue;
            }
            try {
                const text = parseSubtitles(body, { rolling });
                if (text) return { text };
                empty = true;
            } catch (err) {
                if (err?.message === "parse" || err?.message === "html") {
                    garbage = true;
                    continue;
                }
                throw err;
            }
        }
        if (empty) return { error: new CopyError("empty") };
        if (status) return { error: new CopyError("download", { status }) };
        if (garbage) return { error: new CopyError("parse") };
        return { error: new CopyError("download") };
    }

    function waitUntil(fn, timeoutMs) {
        const started = Date.now();
        return new Promise((resolve) => {
            const timer = setInterval(() => {
                if (fn() || Date.now() - started >= timeoutMs) {
                    clearInterval(timer);
                    resolve();
                }
            }, 50);
        });
    }

    function waitForText(videoId, since, timeoutMs) {
        const started = Date.now();
        return new Promise((resolve) => {
            const timer = setInterval(() => {
                const text = textAfter(videoId, since);
                if (text || Date.now() - started >= timeoutMs) {
                    clearInterval(timer);
                    resolve(text);
                }
            }, 100);
        });
    }

    // Прямая ссылка из player response иногда без token плеера. Тогда один раз включаем CC и забираем его запрос.
    async function nudge(videoId) {
        const button = queryPlayer(".ytp-subtitles-button");
        if (!button || button.getAttribute("aria-disabled") === "true") return "";
        const wasOn = isOn(button);
        const since = Date.now();
        try {
            if (wasOn) {
                button.click();
                await waitUntil(
                    () => !button.isConnected || !isOn(button),
                    800,
                );
            }
            if (button.isConnected && !isOn(button)) button.click();
            const text = await waitForText(videoId, since, 4000);
            assertSame(videoId);
            if (text) return text;
            const raw = lastPlayerUrl.get(videoId);
            if (raw && isFresh(raw)) {
                const result = await fetchTimedtext(raw);
                if (result.status === 429) throw new CopyError("rate");
                const kind = new URL(raw).searchParams.get("kind") || "";
                const parsed = safeText(result.body, kind === "asr");
                if (parsed) return parsed;
            }
            return "";
        } finally {
            await sleep(200);
            if (button.isConnected && isOn(button) !== wasOn) button.click();
        }
    }

    async function collectText() {
        if (typeof parseSubtitles !== "function") {
            throw new CopyError("generic");
        }
        if (isAd()) throw new CopyError("ad");
        const videoId = currentVideoId();
        if (!videoId) throw new CopyError("no-video");
        if (!hooksReady()) throw new CopyError("hooks");

        const snapshot = await loadSnapshot(videoId);
        assertSame(videoId);
        if (isAd()) throw new CopyError("ad");

        const tracks = rankTracks(snapshot.tracks, pageLanguage());
        if (!tracks.length) throw new CopyError(noTrackCode(snapshot.playability));

        const preferred = tracks[0];
        if (isOn(queryPlayer(".ytp-subtitles-button"))) {
            const shown = newestText(videoId);
            if (shown) return shown;
        }
        const cached = textMatching(videoId, preferred.languageCode);
        if (cached) return cached;

        const fetched = await fetchPreferred(preferred);
        if (fetched.text) return fetched.text;
        if (fetched.error?.code === "rate") throw fetched.error;
        assertSame(videoId);
        if (isAd()) throw new CopyError("ad");

        const nudged = await nudge(videoId);
        if (nudged) return nudged;
        const any = newestText(videoId);
        if (any) return any;
        throw fetched.error || new CopyError("timeout");
    }

    function execCopy(text) {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "0";
        area.style.left = "0";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch {
            ok = false;
        }
        area.remove();
        return ok;
    }

    function contextDead(err) {
        return /Extension context invalidated|context invalidated/i.test(
            String(err?.message || ""),
        );
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }
        } catch (err) {
            if (contextDead(err)) throw new CopyError("hooks");
        }
        if (execCopy(text)) return;
        try {
            const response = await chrome.runtime.sendMessage({
                type: "copy",
                text,
            });
            if (response?.ok) return;
        } catch (err) {
            if (contextDead(err)) throw new CopyError("hooks");
        }
        throw new CopyError("clipboard");
    }

    function showToast(message, kind) {
        const host = player() || document.body;
        if (!toastEl || !toastEl.isConnected || toastEl.parentElement !== host) {
            toastEl = document.createElement("div");
            toastEl.className = "ytc-toast";
            toastEl.setAttribute("role", "status");
            host.appendChild(toastEl);
        }
        toastEl.dataset.kind = kind;
        toastEl.textContent = message;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl?.remove();
            toastEl = null;
        }, kind === "err" ? 5200 : 2200);
    }

    function setButtonState(state) {
        const button = queryPlayer(".ytc-copy-btn");
        if (!button) return;
        button.dataset.state = state;
        button.classList.toggle("ytc-busy", state === "busy");
        button.classList.toggle("ytc-ok", state === "ok");
        button.classList.toggle("ytc-err", state === "err");
        if (state === "busy") {
            button.setAttribute("aria-busy", "true");
            button.setAttribute("aria-label", "Копирую субтитры");
        } else {
            button.removeAttribute("aria-busy");
            button.setAttribute("aria-label", LABEL);
        }
    }

    function flash(state) {
        setButtonState(state);
        setTimeout(() => {
            const button = queryPlayer(".ytc-copy-btn");
            if (button?.dataset.state === state) setButtonState("idle");
        }, 1600);
    }

    async function onClick() {
        if (busy) return;
        busy = true;
        setButtonState("busy");
        try {
            const text = await collectText();
            await copyText(text);
            showToast(MESSAGES.ok, "ok");
            flash("ok");
        } catch (err) {
            if (!(err instanceof CopyError)) console.warn("[ytc-copy]", err);
            showToast(formatError(err), "err");
            flash("err");
        } finally {
            busy = false;
            const button = queryPlayer(".ytc-copy-btn");
            if (button?.dataset.state === "busy") setButtonState("idle");
        }
    }

    function createButton() {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ytp-button ytc-copy-btn";
        button.title = LABEL;
        button.setAttribute("aria-label", LABEL);
        button.dataset.state = "idle";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path",
        );
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1.8");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("d", "M9 9h10v10H9zM5 15V5h10");
        svg.appendChild(path);
        button.appendChild(svg);
        const stop = (event) => event.stopPropagation();
        button.addEventListener("mousedown", stop);
        button.addEventListener("pointerdown", stop);
        button.addEventListener("mouseup", stop);
        button.addEventListener("pointerup", stop);
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    function rightControls() {
        const nodes = player()?.querySelectorAll(".ytp-right-controls");
        if (!nodes?.length) return null;
        return (
            [...nodes].find((node) => node.getClientRects().length > 0) ||
            nodes[0]
        );
    }

    function controlHost() {
        return (
            queryPlayer(".ytp-subtitles-button")?.parentElement ||
            queryPlayer(".ytp-settings-button")?.parentElement ||
            queryPlayer(".ytp-right-controls-right") ||
            rightControls()
        );
    }

    function ensureButton() {
        const host = controlHost();
        if (!host) return;
        const buttons = [...document.querySelectorAll(".ytc-copy-btn")];
        const kept = buttons.find((node) => host.contains(node));
        for (const node of buttons) {
            if (node !== kept) node.remove();
        }
        if (kept) return;
        const button = createButton();
        const subtitles = queryPlayer(".ytp-subtitles-button");
        const settings = queryPlayer(".ytp-settings-button");
        if (subtitles?.parentElement) {
            subtitles.parentElement.insertBefore(button, subtitles);
            return;
        }
        if (settings?.parentElement) {
            settings.parentElement.insertBefore(button, settings);
            return;
        }
        host.insertBefore(button, host.firstChild);
    }

    let scheduled = false;
    function refreshButton() {
        if (!location.pathname.startsWith("/watch") && !location.pathname.startsWith("/embed/")) {
            document.querySelectorAll(".ytc-copy-btn").forEach((node) => node.remove());
            return;
        }
        ensureButton();
    }
    function schedule() {
        if (scheduled) return;
        scheduled = true;
        const run = () => {
            scheduled = false;
            try {
                refreshButton();
            } catch (err) {
                console.warn("[ytc-copy]", err);
            }
        };
        if (document.hidden) setTimeout(run, 200);
        else requestAnimationFrame(run);
    }

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
    });
    document.addEventListener("yt-navigate-finish", schedule);
    document.addEventListener("visibilitychange", schedule);
    try {
        refreshButton();
    } catch (err) {
        console.warn("[ytc-copy]", err);
    }
    schedule();
})();
