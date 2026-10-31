chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "offscreen-copy") return;
    if (typeof message.text !== "string" || !message.text) {
        sendResponse({ ok: false, error: "empty" });
        return;
    }
    navigator.clipboard.writeText(message.text).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: err?.name || "clipboard" }),
    );
    return true;
});
