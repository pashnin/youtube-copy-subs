import fs from "node:fs";
import vm from "node:vm";

const sandbox = {
    URL,
    JSON,
    Array,
    String,
    Number,
    RegExp,
    Error,
    Object,
    parseInt,
    undefined,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(
    fs.readFileSync(new URL("./parse-subs.js", import.meta.url), "utf8"),
    sandbox,
    { filename: "parse-subs.js" },
);

const {
    parseSubtitles,
    looksLikeHtml,
    isTimedtextUrl,
    buildTimedtextUrls,
    rankTracks,
} = sandbox.YtcParse;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const manual = parseSubtitles(
    JSON.stringify({
        events: [
            { tStartMs: 123456, segs: [{ utf8: "Hello" }] },
            { tStartMs: 200000, segs: [{ utf8: "Hello world" }] },
        ],
    }),
);
assert(manual === "Hello\nHello world", `manual json: ${manual}`);
assert(!manual.includes("123456"), "timestamp leaked");

const rolling = parseSubtitles(
    JSON.stringify({
        events: [
            { tStartMs: 0, segs: [{ utf8: "Hello" }] },
            { tStartMs: 500, segs: [{ utf8: "Hello world" }] },
            { tStartMs: 800, aAppend: 1, segs: [{ utf8: "today" }] },
            { tStartMs: 2000, segs: [{ utf8: "\n" }] },
        ],
    }),
    { rolling: true },
);
assert(rolling === "Hello world today", `rolling: ${rolling}`);

const xml = parseSubtitles(
    "<transcript><text start=\"0\" dur=\"1.2\">Hello &amp; welcome</text><text start=\"1.2\" dur=\"1\">It&#39;s next</text></transcript>",
);
assert(xml === "Hello & welcome\nIt's next", `xml: ${xml}`);

const srv3 = parseSubtitles(
    '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="160" d="2640"><s>Hello</s><s> &amp; </s><s>welcome</s></p><p t="3000" d="1000"></p><p t="4000" d="1000">Next</p></body></timedtext>',
);
assert(srv3 === "Hello & welcome\nNext", `srv3: ${srv3}`);

const vtt = parseSubtitles(
    "WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:02.000\nHello there\n\n00:00:02.000 --> 00:00:03.000\nSecond line\n",
);
assert(vtt === "Hello there\nSecond line", `vtt: ${vtt}`);
assert(!vtt.includes("-->"), "vtt timestamp leaked");
assert(!vtt.includes("00:00"), "vtt clock leaked");

assert(looksLikeHtml("<!DOCTYPE html><html></html>"), "html not detected");
let htmlThrew = false;
try {
    parseSubtitles("<!DOCTYPE html><html><body>nope</body></html>");
} catch (err) {
    htmlThrew = err?.message === "html";
}
assert(htmlThrew, "html should throw");

assert(parseSubtitles('{"events":[]}') === "", "empty events");
let badJson = false;
try {
    parseSubtitles("{not json");
} catch (err) {
    badJson = err?.message === "parse";
}
assert(badJson, "bad json should throw");

const urls = buildTimedtextUrls(
    "https://www.youtube.com/api/timedtext?v=abc&lang=ru&fmt=srv3&signature=sig&sparams=v",
);
assert(urls.length === 2, "expected two urls");
assert(new URL(urls[0]).searchParams.get("fmt") === "json3", "fmt json3");
assert(new URL(urls[0]).searchParams.get("signature") === "sig", "signature kept");
assert(new URL(urls[1]).searchParams.get("fmt") === "srv3", "original fmt");
assert(
    buildTimedtextUrls("https://www.youtube.com/api/timedtext?v=abc&fmt=json3")
        .length === 1,
    "json3 should not duplicate",
);

assert(
    isTimedtextUrl("https://www.youtube.com/api/timedtext?v=1") === true,
    "timedtext url",
);
assert(isTimedtextUrl("https://evil.com/api/timedtext?v=1") === false, "evil host");
assert(isTimedtextUrl("https://www.youtube.com/watch?v=1") === false, "watch url");

const ranked = rankTracks(
    [
        {
            languageCode: "en",
            kind: "",
            baseUrl: "https://www.youtube.com/api/timedtext?v=1&lang=en",
        },
        {
            languageCode: "ru",
            kind: "asr",
            baseUrl: "https://www.youtube.com/api/timedtext?v=1&lang=ru&kind=asr",
        },
        {
            languageCode: "ru",
            kind: "",
            baseUrl: "https://www.youtube.com/api/timedtext?v=1&lang=ru",
        },
        { languageCode: "de", kind: "", baseUrl: "" },
    ],
    "ru-RU",
);
assert(ranked.length === 3, "empty baseUrl dropped");
assert(ranked[0].languageCode === "ru" && ranked[0].kind === "", "ru manual first");
assert(ranked[1].kind === "asr", "ru asr second");
assert(ranked[2].languageCode === "en", "en last");

console.log("parse-subs tests passed");
