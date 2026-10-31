(function () {
    "use strict";
    try {
        if (window.top !== window) return;
    } catch {
        return;
    }
    if (globalThis.__ytcPageHooks) return;
    globalThis.__ytcPageHooks = true;
    document.documentElement.dataset.ytcPageHooks = "1";
    if (!document.querySelector("meta[name='ytc-page-hooks']")) {
        const meta = document.createElement("meta");
        meta.setAttribute("name", "ytc-page-hooks");
        meta.setAttribute("content", "1");
        (document.head || document.documentElement).appendChild(meta);
    }

    const SOURCE = "ytc-copy";
    const PAGE = "ytc-copy-page";

    const isTimedtextUrl = (raw) =>
        globalThis.YtcParse?.isTimedtextUrl(raw) === true;

    const post = (payload) => {
        window.postMessage({ source: PAGE, ...payload }, location.origin);
    };

    const readPlayer = () => {
        try {
            const player = document.getElementById("movie_player");
            const live = player?.getPlayerResponse?.() || null;
            const initial = globalThis.ytInitialPlayerResponse || null;
            const response =
                live?.videoDetails?.videoId ? live : initial || live;
            if (!response) return null;
            const list =
                response.captions?.playerCaptionsTracklistRenderer
                    ?.captionTracks;
            const tracks = Array.isArray(list)
                ? list
                      .map((track) => ({
                          languageCode: track?.languageCode || "",
                          kind: track?.kind || "",
                          baseUrl: track?.baseUrl || "",
                      }))
                      .filter((track) => track.baseUrl)
                : [];
            return {
                videoId: response.videoDetails?.videoId || null,
                playability: response.playabilityStatus?.status || "",
                tracks,
            };
        } catch {
            return null;
        }
    };

    const replyFetch = async (requestId, rawUrl) => {
        if (!isTimedtextUrl(rawUrl)) {
            post({
                type: "fetch-timedtext",
                requestId,
                ok: false,
                status: 0,
                body: "",
            });
            return;
        }
        try {
            const res = await origFetch(rawUrl, {
                credentials: "include",
                signal: AbortSignal.timeout(10000),
            });
            const body = res.ok ? await res.text() : "";
            post({
                type: "fetch-timedtext",
                requestId,
                ok: res.ok,
                status: res.status,
                body,
            });
        } catch (err) {
            post({
                type: "fetch-timedtext",
                requestId,
                ok: false,
                status: 0,
                body: "",
                error: err?.name || "fetch",
            });
        }
    };

    window.addEventListener("message", (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.source !== SOURCE) return;
        if (data.type === "player-response") {
            post({
                type: "player-response",
                requestId: data.requestId,
                value: readPlayer(),
            });
            return;
        }
        if (data.type === "fetch-timedtext") {
            replyFetch(data.requestId, data.url);
        }
    });

    // Плеер сам дописывает короткий token в запрос субтитров. Забираем тело, которое он уже скачал.
    const postBody = (url, body) => {
        post({
            type: "subtitle-body",
            url,
            body: typeof body === "string" && body.length ? body : null,
        });
    };

    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        const promise = origFetch.apply(this, args);
        if (isTimedtextUrl(url)) {
            promise
                .then((response) =>
                    response.ok ? response.clone().text() : null,
                )
                .then((body) => postBody(url, body))
                .catch(() => postBody(url, null));
        }
        return promise;
    };

    const subtitleRequests = new WeakMap();
    const withLoad = new WeakSet();

    const readXhrBody = (xhr) => {
        if (xhr.responseType === "" || xhr.responseType === "text") {
            return xhr.responseText;
        }
        if (xhr.responseType === "json") {
            return JSON.stringify(xhr.response);
        }
        if (xhr.responseType === "arraybuffer" && xhr.response) {
            return new TextDecoder().decode(xhr.response);
        }
        return null;
    };

    const onLoadEnd = function () {
        const url = subtitleRequests.get(this);
        if (!url) return;
        if (this.responseType === "blob" && this.response) {
            this.response
                .text()
                .then((body) => postBody(url, this.status === 200 ? body : null))
                .catch(() => postBody(url, null));
            return;
        }
        let body = null;
        try {
            body = this.status === 200 ? readXhrBody(this) : null;
        } catch {
            body = null;
        }
        postBody(url, body);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (isTimedtextUrl(url)) {
            subtitleRequests.set(this, String(url));
            if (!withLoad.has(this)) {
                withLoad.add(this);
                this.addEventListener("loadend", onLoadEnd);
            }
        } else {
            subtitleRequests.delete(this);
        }
        return origOpen.apply(this, arguments);
    };

    document.addEventListener(
        "keydown",
        (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!target.closest(".ytc-copy-btn")) return;
            if (event.key !== " " && event.key !== "Enter") return;
            event.stopPropagation();
        },
        true,
    );
})();
