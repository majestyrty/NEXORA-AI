const settingDefaults = { theme: "dark", enter: true, timestamps: true, animations: true, scroll: true, stream: true, preview: true, responseStyle: "Balanced", particles: true };
const settingKeys = { theme: "nexora_theme", enter: "nexora_enter_to_send", timestamps: "nexora_show_timestamps", animations: "nexora_message_animations", scroll: "nexora_auto_scroll", stream: "nexora_streaming", preview: "nexora_image_previews", responseStyle: "nexora_response_style", particles: "nexora_particles" };
const preferences = Object.fromEntries(Object.entries(settingDefaults).map(([key, fallback]) => [key, localStorage.getItem(settingKeys[key]) === null ? fallback : JSON.parse(localStorage.getItem(settingKeys[key]))]));
const $ = (id) => document.getElementById(id);
function applyTheme() {
    const theme = preferences.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preferences.theme;
    document.body.classList.toggle("light-mode", theme === "light");
}
function update(key, value) { preferences[key] = value; localStorage.setItem(settingKeys[key], JSON.stringify(value)); applyTheme(); }
function syncControls() {
    $("themeSelect").value = preferences.theme; $("enterToggle").checked = preferences.enter; $("timestampToggle").checked = preferences.timestamps; $("animationToggle").checked = preferences.animations; $("scrollToggle").checked = preferences.scroll; $("streamToggle").checked = preferences.stream; $("previewToggle").checked = preferences.preview; $("styleSelect").value = preferences.responseStyle; $("particleToggle").checked = preferences.particles;
    const canvas = $("particleCanvas"); if (canvas) canvas.style.display = preferences.particles ? "block" : "none";
}
window.NexoraSettings = { get: (key) => preferences[key] };
[["themeSelect", "theme"], ["enterToggle", "enter"], ["timestampToggle", "timestamps"], ["animationToggle", "animations"], ["scrollToggle", "scroll"], ["streamToggle", "stream"], ["previewToggle", "preview"], ["styleSelect", "responseStyle"], ["particleToggle", "particles"]].forEach(([id, key]) => $(id).addEventListener("change", (event) => update(key, event.target.type === "checkbox" ? event.target.checked : event.target.value)));
function openSettings() { $("settingsPanel").classList.remove("hidden"); $("settingsOverlay").classList.remove("hidden"); requestAnimationFrame(() => $("settingsPanel").classList.add("visible")); }
function closeSettings() { $("settingsPanel").classList.add("hidden"); $("settingsOverlay").classList.add("hidden"); }
$("settingsBtn").onclick = openSettings; $("closeSettings").onclick = closeSettings; $("settingsOverlay").onclick = closeSettings;
$("clearChatBtn").onclick = () => { document.getElementById("newChatBtn").click(); };
$("clearAllBtn").onclick = () => { if (confirm("Clear all locally stored conversations? This cannot be undone.")) { localStorage.removeItem("nexora_chats"); location.reload(); } };
$("exportBtn").onclick = () => { const messages = [...document.querySelectorAll(".message")].map((item) => item.innerText).join("\n\n"); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([messages], { type: "text/plain" })); link.download = "nexora-chat.txt"; link.click(); URL.revokeObjectURL(link.href); };
syncControls();
