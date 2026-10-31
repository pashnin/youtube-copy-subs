(function (root) {
    "use strict";

    function primary(code) {
        return String(code || "")
            .toLowerCase()
            .split("-")[0];
    }

    function fromCodePointSafe(value) {
        const code = Number(value);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
        try {
            return String.fromCodePoint(code);
        } catch {
            return "";
        }
    }

    function decodeEntities(value) {
        return value
            .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
                fromCodePointSafe(parseInt(hex, 16)),
            )
            .replace(/&#(\d+);/g, (_, dec) => fromCodePointSafe(dec))
            .replace(/&nbsp;/gi, " ")
            .replace(/&quot;/gi, '"')
            .replace(/&apos;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&amp;/gi, "&");
    }

    function cleanCue(value) {
        const stripped = String(value)
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]+>/g, "");
        return decodeEntities(stripped)
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function joinAppend(prev, piece) {
        if (/^[),.;:!?…]/.test(piece)) return prev + piece;
        return `${prev} ${piece}`;
    }

    // У автосубтитров следующая фраза часто повторяет предыдущую целиком и добавляет слова.
    function collapseRolling(lines) {
        const out = [];
        for (const line of lines) {
            const prev = out[out.length - 1];
            if (!prev) {
                out.push(line);
                continue;
            }
            if (line === prev || prev.startsWith(line)) continue;
            if (line.startsWith(prev)) {
                out[out.length - 1] = line;
                continue;
            }
            out.push(line);
        }
        return out;
    }

    function linesFromEvents(events, rolling) {
        const lines = [];
        for (const event of events) {
            if (!event || !Array.isArray(event.segs)) continue;
            const piece = cleanCue(
                event.segs
                    .map((seg) =>
                        typeof seg?.utf8 === "string" ? seg.utf8 : "",
                    )
                    .join(""),
            );
            if (!piece) continue;
            if (event.aAppend && lines.length) {
                lines[lines.length - 1] = joinAppend(
                    lines[lines.length - 1],
                    piece,
                );
            } else {
                lines.push(piece);
            }
        }
        return rolling ? collapseRolling(lines) : lines;
    }

    function extractTag(xml, tag) {
        const re = new RegExp(
            `<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`,
            "gi",
        );
        const blocks = [];
        let match = re.exec(xml);
        while (match) {
            blocks.push(match[1]);
            match = re.exec(xml);
        }
        return blocks;
    }

    function looksLikeHtml(raw) {
        const start = String(raw ?? "")
            .replace(/^\uFEFF/, "")
            .trimStart()
            .slice(0, 300)
            .toLowerCase();
        return (
            start.startsWith("<!doctype html") ||
            start.startsWith("<html") ||
            start.startsWith("<head")
        );
    }

    function parseJson(source, rolling) {
        let data;
        try {
            data = JSON.parse(source);
        } catch {
            throw new Error("parse");
        }
        const events =
            data && Array.isArray(data.events) ? data.events : null;
        if (!events) return "";
        return linesFromEvents(events, rolling).join("\n").trim();
    }

    function parseXml(source, rolling) {
        const texts = extractTag(source, "text");
        const blocks = texts.length ? texts : extractTag(source, "p");
        const lines = [];
        for (const block of blocks) {
            const line = cleanCue(block);
            if (line) lines.push(line);
        }
        return (rolling ? collapseRolling(lines) : lines).join("\n").trim();
    }

    function parseVtt(source, rolling) {
        const rows = source
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n");
        const cues = [];
        let buf = [];
        const flush = () => {
            if (!buf.length) return;
            const text = cleanCue(buf.join(" "));
            if (text) cues.push(text);
            buf = [];
        };
        for (const row of rows) {
            const trimmed = row.trim();
            if (!trimmed) {
                flush();
                continue;
            }
            if (
                trimmed.startsWith("WEBVTT") ||
                trimmed.startsWith("NOTE") ||
                trimmed.startsWith("STYLE") ||
                trimmed.startsWith("REGION") ||
                /^X-TIMESTAMP-MAP/i.test(trimmed) ||
                /^(Kind|Language)\b/i.test(trimmed) ||
                trimmed.includes("-->") ||
                /^\d+$/.test(trimmed)
            ) {
                continue;
            }
            buf.push(trimmed);
        }
        flush();
        return (rolling ? collapseRolling(cues) : cues).join("\n").trim();
    }

    function parseSubtitles(raw, options) {
        const rolling = Boolean(options && options.rolling);
        const source = String(raw ?? "")
            .replace(/^\uFEFF/, "")
            .trim();
        if (!source) return "";
        if (source.length > 3000000) throw new Error("parse");
        if (looksLikeHtml(source)) throw new Error("html");
        if (source.startsWith("{") || source.startsWith("[")) {
            return parseJson(source, rolling);
        }
        if (source.startsWith("WEBVTT") || source.includes("\nWEBVTT")) {
            return parseVtt(source, rolling);
        }
        if (source.startsWith("<")) return parseXml(source, rolling);
        throw new Error("parse");
    }

    function isTimedtextUrl(raw) {
        try {
            const url = new URL(raw, "https://www.youtube.com");
            const host = url.hostname;
            return (
                url.protocol === "https:" &&
                (host === "www.youtube.com" || host === "youtube.com") &&
                url.pathname === "/api/timedtext"
            );
        } catch {
            return false;
        }
    }

    function buildTimedtextUrls(baseUrl) {
        const original = new URL(baseUrl, "https://www.youtube.com");
        if (!isTimedtextUrl(original.href)) throw new Error("url");
        const asJson = new URL(original.href);
        asJson.searchParams.set("fmt", "json3");
        const urls = [asJson.href];
        if ((original.searchParams.get("fmt") || "") !== "json3") {
            urls.push(original.href);
        }
        return urls;
    }

    function scoreTrack(track, want) {
        const code = String(track.languageCode || "").toLowerCase();
        let score = 0;
        if (want && primary(code) === want) score += 100;
        if (want && code === want) score += 10;
        if (track.kind !== "asr") score += 5;
        return score;
    }

    function rankTracks(tracks, pageLang) {
        const want = primary(pageLang);
        return (Array.isArray(tracks) ? tracks : [])
            .filter(
                (track) =>
                    track &&
                    typeof track.baseUrl === "string" &&
                    track.baseUrl,
            )
            .slice()
            .sort((a, b) => scoreTrack(b, want) - scoreTrack(a, want));
    }

    root.YtcParse = {
        parseSubtitles,
        looksLikeHtml,
        isTimedtextUrl,
        buildTimedtextUrls,
        rankTracks,
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
