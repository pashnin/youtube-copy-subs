const OFFSCREEN_URL = "src/offscreen.html";
const MAX_CHARS = 2000000;

async function ensureOffscreen() {
    if (!chrome.offscreen?.createDocument) {
        throw new Error("offscreen");
    }
    if (await chrome.offscreen.hasDocument()) return;
    try {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: ["CLIPBOARD"],
            justification:
                "Copy YouTube subtitles after the player responds and the click gesture has expired.",
        });
    } catch (err) {
        if (!/single offscreen/i.test(String(err?.message || ""))) throw err;
    }
}

async function copyViaOffscreen(text) {
    await ensureOffscreen();
    let lastError = "clipboard";
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const response = await chrome.runtime.sendMessage({
                type: "offscreen-copy",
                text,
            });
            if (response?.ok) return { ok: true };
            lastError = response?.error || lastError;
        } catch (err) {
            lastError = err?.name || lastError;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, error: lastError };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "copy") return;
    if (sender.id !== chrome.runtime.id || !sender.tab) {
        sendResponse({ ok: false, error: "sender" });
        return;
    }
    if (typeof message.text !== "string" || !message.text) {
        sendResponse({ ok: false, error: "empty" });
        return;
    }
    if (message.text.length > MAX_CHARS) {
        sendResponse({ ok: false, error: "too-long" });
        return;
    }
    copyViaOffscreen(message.text).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: err?.name || "clipboard" }),
    );
    return true;
});
