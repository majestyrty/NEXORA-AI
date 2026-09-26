const chat = document.getElementById("chat");
const input = document.getElementById("message");
const sendBtn = document.getElementById("sendBtn");
const fileInput = document.getElementById("fileInput");
const attachmentPreview = document.getElementById("attachmentPreview");
const modelSelect = document.getElementById("modelSelect");
const state = { files: [], conversations: JSON.parse(localStorage.getItem("nexora_chats") || "[]"), current: [], sending: false, config: null, user: null, provider: "gemini", authMode: "login", pendingSignup: null, headlineTimer: null };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
function formatText(text) { return escapeHtml(text).replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>").replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>"); }
function timestamp() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function addMessage(text, sender, files = [], time = timestamp()) {
    const message = document.createElement("article"); message.className = `message ${sender}`;
    const timeMarkup = window.NexoraSettings?.get("timestamps") === false ? "" : `<time>${time}</time>`;
    message.innerHTML = `<div class="message-meta">${sender === "bot" ? "✦ Nexora AI" : "You"} ${timeMarkup}</div><div class="message-content">${formatText(text)}</div>`;
    if (files.length) { const list = document.createElement("div"); list.className = "message-files"; files.forEach((file) => { const item = document.createElement("span"); item.textContent = `📎 ${file.name}`; list.appendChild(item); }); message.appendChild(list); }
    chat.appendChild(message); if (window.NexoraSettings?.get("scroll")) chat.scrollTop = chat.scrollHeight;
}
function saveConversation() {
    if (!state.current.length) return;
    const title = state.current.find((item) => item.sender === "user")?.text.slice(0, 42) || "New conversation";
    const record = { id: state.current.id || crypto.randomUUID(), title, messages: state.current }; state.current.id = record.id;
    const existing = state.conversations.findIndex((item) => item.id === record.id); if (existing >= 0) state.conversations[existing] = record; else state.conversations.unshift(record);
    localStorage.setItem("nexora_chats", JSON.stringify(state.conversations.slice(0, 50))); renderConversations();
}
function renderConversations(filter = "") {
    const list = document.getElementById("convoList"); list.innerHTML = "";
    state.conversations.filter((item) => `${item.title} ${item.messages.map((m) => m.text).join(" ")}`.toLowerCase().includes(filter.toLowerCase())).forEach((item) => { const button = document.createElement("button"); button.className = "convo-item"; button.textContent = item.title; button.onclick = () => loadConversation(item); list.appendChild(button); });
}
function loadConversation(record) { chat.innerHTML = ""; state.current = record.messages; state.current.id = record.id; state.current.forEach((message) => addMessage(message.text, message.sender, [], message.time)); }
function newChat() { chat.innerHTML = ""; state.current = []; state.files = []; renderAttachments(); addMessage("Welcome to Nexora AI. Ask a question or attach a file to get started.", "bot"); }
function renderAttachments() {
    attachmentPreview.innerHTML = "";
    state.files.forEach((file, index) => {
        const item = document.createElement("div"); item.className = "attachment-card";
        const icon = file.type.startsWith("image/") && window.NexoraSettings?.get("preview") ? `<img src="${URL.createObjectURL(file)}" alt="">` : `<span class="file-icon">${file.type.includes("pdf") ? "PDF" : "📄"}</span>`;
        item.innerHTML = `${icon}<span class="attachment-name">${escapeHtml(file.name)}<small>${(file.size / 1024 / 1024).toFixed(2)} MB</small></span><button type="button" aria-label="Remove ${escapeHtml(file.name)}">×</button>`;
        item.querySelector("button").onclick = () => { state.files.splice(index, 1); renderAttachments(); updateSendState(); }; attachmentPreview.appendChild(item);
    });
}
function updateSendState() { sendBtn.disabled = state.sending || (!input.value.trim() && !state.files.length); }
function setSending(value) { state.sending = value; sendBtn.disabled = value; sendBtn.innerHTML = value ? '<span class="send-spinner" aria-hidden="true"></span>' : '<span class="send-icon" aria-hidden="true">↑</span>'; if (!value) updateSendState(); }
function providerModelLabel() { const option = modelSelect.options[modelSelect.selectedIndex]; return `${state.provider === "openai" ? "OpenAI" : "Gemini"} · ${option?.text || ""}`; }
function setUser(user) {
    state.user = user; const name = user.name || "Nexora user"; const avatar = user.picture || "";
    ["userName", "settingsUserName"].forEach((id) => document.getElementById(id).textContent = name);
    ["userEmail", "settingsUserEmail"].forEach((id) => document.getElementById(id).textContent = user.email || "");
    ["userAvatar", "settingsAvatar"].forEach((id) => { const image = document.getElementById(id); image.src = avatar || "logo.png"; image.alt = `${name} profile`; });
}
function showAuthScreen(message = "") { document.body.classList.add("auth-checking"); document.getElementById("authScreen").hidden = false; document.getElementById("authError").textContent = message; animateWelcomeHeadline(); }
function showApp() { document.body.classList.remove("auth-checking"); document.getElementById("authScreen").hidden = true; }
function animateWelcomeHeadline() {
    const headline = document.getElementById("welcomeHeadline");
    if (!headline || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const title = "Think Rightly. Create boldly.";
    clearTimeout(state.headlineTimer);
    headline.classList.add("typing");
    headline.textContent = "";
    let index = 0;
    const typeNext = () => {
        headline.textContent = title.slice(0, ++index);
        if (index < title.length) state.headlineTimer = setTimeout(typeNext, 48);
        else headline.classList.remove("typing");
    };
    typeNext();
}
function isChatPage() { return window.location.pathname === "/chat"; }
function fetchWithTimeout(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}
async function enterApp(user) {
    setUser(user);
    await loadConfig();
    showApp();
    renderConversations();
    newChat();
}
function redirectToChat() {
    window.location.assign("/chat");
}
function renderGoogleButton() {
    const button = document.getElementById("googleSignInButton");
    if (!button) return;
    if (!state.config?.googleClientId) {
        button.disabled = true;
        button.textContent = "Google sign-in unavailable";
        return;
    }
    if (!window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({ client_id: state.config.googleClientId, callback: async ({ credential }) => {
        try {
            const signup = state.pendingSignup || undefined;
            const response = await fetch("/auth/google", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential, signup }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.message); state.pendingSignup = null; redirectToChat();
        } catch (error) { document.getElementById("authError").textContent = error.message || "Google authentication failed. Please try again."; }
    } });
    button.disabled = false;
    button.onclick = beginGoogleSignIn;
}
function setAuthMode(mode) {
    state.authMode = mode;
    const signingUp = mode === "signup";
    document.getElementById("signupFields").hidden = !signingUp;
    document.getElementById("loginModeButton").classList.toggle("active", !signingUp);
    document.getElementById("signupModeButton").classList.toggle("active", signingUp);
    document.getElementById("loginModeButton").setAttribute("aria-pressed", String(!signingUp));
    document.getElementById("signupModeButton").setAttribute("aria-pressed", String(signingUp));
    document.getElementById("authCopy").textContent = signingUp ? "Create your Nexora account and personalize your AI experience." : "Sign in to bring your conversations, files, and AI tools together.";
    document.getElementById("googleSignInButton").textContent = signingUp ? "Sign up with Google" : "Continue with Google";
    document.getElementById("authError").textContent = "";
}
function beginGoogleSignIn() {
    state.pendingSignup = null;
    if (state.authMode === "signup") {
        const name = document.getElementById("signupName").value.trim();
        const age = Number(document.getElementById("signupAge").value);
        if (!name || name.length > 80) { document.getElementById("authError").textContent = "Enter your name (up to 80 characters) to sign up."; document.getElementById("signupName").focus(); return; }
        if (!Number.isInteger(age) || age < 1 || age > 120) { document.getElementById("authError").textContent = "Enter a valid age between 1 and 120 to sign up."; document.getElementById("signupAge").focus(); return; }
        state.pendingSignup = { name, age };
    }
    if (!window.google?.accounts?.id) { document.getElementById("authError").textContent = "Google sign-in is still loading. Please try again."; return; }
    window.google.accounts.id.prompt();
}
async function handleUnauthorized() { state.user = null; showAuthScreen("Your session expired. Please sign in again."); if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect(); renderGoogleButton(); }
async function loadConfig() {
    state.config = await fetchWithTimeout("/config").then((response) => response.json());
    const savedProvider = localStorage.getItem("nexora_provider") || "gemini"; state.provider = state.config.providers[savedProvider] ? savedProvider : Object.keys(state.config.providers)[0];
    populateModels(localStorage.getItem("nexora_selected_model"));
}
function populateModels(preferred) {
    const models = state.config.providers[state.provider].models; modelSelect.innerHTML = models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("");
    modelSelect.value = models.includes(preferred) ? preferred : models[0]; localStorage.setItem("nexora_provider", state.provider); localStorage.setItem("nexora_selected_model", modelSelect.value);
    document.getElementById("statusModel").textContent = providerModelLabel();
    const providerSelect = document.getElementById("providerSelect"); if (providerSelect) providerSelect.value = state.provider;
    const settingsModels = document.getElementById("settingsModelSelect"); if (settingsModels) { settingsModels.innerHTML = models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join(""); settingsModels.value = modelSelect.value; }
}
async function sendMessage() {
    if (state.sending || (!input.value.trim() && !state.files.length)) return;
    const text = input.value.trim(); const files = [...state.files]; addMessage(text || "Please analyze these files.", "user", files); state.current.push({ text: text || "Please analyze these files.", sender: "user", time: timestamp() });
    input.value = ""; state.files = []; renderAttachments(); setSending(true);
    const bot = document.createElement("article"); bot.className = "message bot"; bot.innerHTML = '<div class="message-meta">✦ Nexora AI</div><div class="message-content thinking" role="status" aria-label="Nexora AI is responding"><span></span><span></span><span></span></div>'; chat.appendChild(bot);
    try {
        let reply = "";
        const query = `message=${encodeURIComponent(text)}&provider=${encodeURIComponent(state.provider)}&model=${encodeURIComponent(modelSelect.value)}&responseStyle=${encodeURIComponent(window.NexoraSettings.get("responseStyle"))}`;
        if (!files.length && window.NexoraSettings.get("stream")) {
            const es = new EventSource(`/stream?${query}`);
            await new Promise((resolve, reject) => { es.onmessage = (event) => { const payload = JSON.parse(event.data); if (payload.type === "partial") { reply += payload.text; bot.querySelector(".message-content").innerHTML = formatText(reply); } if (payload.type === "done") { es.close(); resolve(); } if (payload.type === "error") { es.close(); reject(new Error(payload.message)); } }; es.onerror = () => { es.close(); reject(new Error("network")); }; });
        } else {
            const form = new FormData(); form.append("message", text); form.append("provider", state.provider); form.append("model", modelSelect.value); form.append("responseStyle", window.NexoraSettings.get("responseStyle")); files.forEach((file) => form.append("attachments", file, file.name));
            const response = await fetch("/chat", { method: "POST", body: form }); const data = await response.json(); if (response.status === 401) return handleUnauthorized(); if (!response.ok) throw new Error(data.reply); reply = data.reply; bot.querySelector(".message-content").innerHTML = formatText(reply);
        }
        bot.querySelector(".message-meta").innerHTML += ` <time>${timestamp()}</time>`; state.current.push({ text: reply, sender: "bot", time: timestamp() }); saveConversation();
    } catch (error) { bot.querySelector(".message-content").textContent = error.message === "network" ? "Nexora AI is having trouble connecting. Please check your connection and try again." : error.message; } finally { setSending(false); }
}
document.getElementById("attachBtn").onclick = () => fileInput.click();
fileInput.onchange = () => {
    const maxSize = (state.config?.maxFileSize || 100 * 1024 * 1024);
    const selected = Array.from(fileInput.files);
    const oversized = selected.find((file) => file.size > maxSize);
    if (oversized) {
        document.getElementById("fileError").textContent = `${oversized.name} is too large. Files must be 100 MB or smaller.`;
        fileInput.value = "";
        return;
    }
    document.getElementById("fileError").textContent = "";
    state.files.push(...selected);
    fileInput.value = "";
    renderAttachments();
    updateSendState();
};
input.oninput = updateSendState;
input.onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey && window.NexoraSettings.get("enter")) { event.preventDefault(); sendMessage(); } };
sendBtn.onclick = sendMessage; document.getElementById("newChatBtn").onclick = newChat; document.getElementById("searchChats").oninput = (event) => renderConversations(event.target.value); document.getElementById("mobileMenuBtn").onclick = () => document.getElementById("sidebar").classList.toggle("open");
document.getElementById("modelSelect").onchange = () => { localStorage.setItem("nexora_selected_model", modelSelect.value); document.getElementById("statusModel").textContent = providerModelLabel(); };
window.addEventListener("nexora-provider-change", (event) => { state.provider = event.detail; populateModels(); });
document.getElementById("logoutBtn").onclick = () => document.getElementById("settingsLogoutBtn").click();
document.getElementById("loginModeButton").onclick = () => setAuthMode("login");
document.getElementById("signupModeButton").onclick = () => setAuthMode("signup");
document.getElementById("googleSignInButton").onclick = beginGoogleSignIn;

(async function init() {
    try {
        state.config = await fetch("/config").then((response) => response.json());
        let session;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            session = await fetch("/auth/me", { credentials: "same-origin", cache: "no-store" });
            if (session.ok || attempt === 2) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!session.ok) {
            if (isChatPage()) {
                window.location.replace("/");
                return;
            }
            showAuthScreen(state.config.googleClientId ? "" : "Google sign-in is not configured on the server. Add GOOGLE_CLIENT_ID to .env.");
            const waitForGoogle = setInterval(() => { if (window.google?.accounts?.id) { clearInterval(waitForGoogle); renderGoogleButton(); } }, 100);
            return;
        }
        const data = await session.json(); await enterApp(data.user);
    } catch (error) { showAuthScreen("Unable to connect to Nexora AI. Please refresh and try again."); }
})();
