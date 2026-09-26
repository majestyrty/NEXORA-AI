const settingDefaults = { theme: "dark", accent: "blue", enter: true, timestamps: true, animations: true, scroll: true, stream: true, preview: true, responseStyle: "Balanced", particles: true };
const settingKeys = { theme: "nexora_theme", accent: "nexora_accent", enter: "nexora_enter_to_send", timestamps: "nexora_show_timestamps", animations: "nexora_message_animations", scroll: "nexora_auto_scroll", stream: "nexora_streaming", preview: "nexora_image_previews", responseStyle: "nexora_response_style", particles: "nexora_particles" };
function readPreference(key, fallback) {
    try { const saved = localStorage.getItem(settingKeys[key]); return saved === null ? fallback : JSON.parse(saved); }
    catch { return fallback; }
}
const preferences = Object.fromEntries(Object.entries(settingDefaults).map(([key, fallback]) => [key, readPreference(key, fallback)]));
const $ = (id) => document.getElementById(id);
const accents = {
    blue: ["#3b82f6", "#2563eb"], red: ["#ef4444", "#b91c1c"], black: ["#475569", "#0f172a"],
    purple: ["#a855f7", "#7e22ce"], green: ["#22c55e", "#15803d"], orange: ["#f97316", "#c2410c"]
};
function applyTheme() {
    const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const activeTheme = preferences.theme === "system" ? (prefersDark ? "dark" : "light") : preferences.theme;
    document.body.dataset.theme = activeTheme;
    document.body.classList.toggle("light-mode", activeTheme === "light");
    const [accent, strong] = accents[preferences.accent] || accents.blue;
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-strong", strong);
}
function update(key, value) { preferences[key] = value; localStorage.setItem(settingKeys[key], JSON.stringify(value)); applyTheme(); }
function syncControls() {
    $("themeSelect").value = preferences.theme; $("accentSelect").value = preferences.accent;
    $("enterToggle").checked = preferences.enter; $("timestampToggle").checked = preferences.timestamps; $("animationToggle").checked = preferences.animations; $("scrollToggle").checked = preferences.scroll; $("streamToggle").checked = preferences.stream; $("previewToggle").checked = preferences.preview; $("styleSelect").value = preferences.responseStyle; $("particleToggle").checked = preferences.particles;
    const canvas = $("particleCanvas"); if (canvas) canvas.style.display = preferences.particles ? "block" : "none";
}
window.NexoraSettings = { get: (key) => preferences[key] };
[["themeSelect", "theme"], ["accentSelect", "accent"], ["enterToggle", "enter"], ["timestampToggle", "timestamps"], ["animationToggle", "animations"], ["scrollToggle", "scroll"], ["streamToggle", "stream"], ["previewToggle", "preview"], ["styleSelect", "responseStyle"], ["particleToggle", "particles"]].forEach(([id, key]) => $(id).addEventListener("change", (event) => update(key, event.target.type === "checkbox" ? event.target.checked : event.target.value)));
function openSettings() { $("settingsPanel").classList.remove("hidden"); $("settingsOverlay").classList.remove("hidden"); requestAnimationFrame(() => $("settingsPanel").classList.add("visible")); }
function closeSettings() { $("settingsPanel").classList.add("hidden"); $("settingsOverlay").classList.add("hidden"); }
$("settingsBtn").onclick = openSettings; $("closeSettings").onclick = closeSettings; $("settingsOverlay").onclick = closeSettings;
$("providerSelect").onchange = (event) => window.dispatchEvent(new CustomEvent("nexora-provider-change", { detail: event.target.value }));
$("settingsModelSelect").onchange = (event) => { const select = $("modelSelect"); select.value = event.target.value; select.dispatchEvent(new Event("change")); };
$("settingsLogoutBtn").onclick = async () => {
    if (!confirm("Sign out of Nexora AI?")) return;
    const response = await fetch("/auth/logout", { method: "POST" });
    if (response.ok) { window.google?.accounts?.id.disableAutoSelect(); location.reload(); }
};
$("clearChatBtn").onclick = () => $("newChatBtn").click();
$("clearAllBtn").onclick = () => { if (confirm("Clear all locally stored conversations? This cannot be undone.")) { localStorage.removeItem("nexora_chats"); location.reload(); } };
$("exportBtn").onclick = () => { const messages = [...document.querySelectorAll(".message")].map((item) => item.innerText).join("\n\n"); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([messages], { type: "text/plain" })); link.download = "nexora-chat.txt"; link.click(); URL.revokeObjectURL(link.href); };
syncControls(); applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (preferences.theme === "system") applyTheme(); });
