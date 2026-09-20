const chat = document.getElementById("chat");
const input = document.getElementById("message");
const sendBtn = document.getElementById("sendBtn");
const fileInput = document.getElementById("fileInput");
const attachmentPreview = document.getElementById("attachmentPreview");
const modelSelect = document.getElementById("modelSelect");
const state = { files: [], conversations: JSON.parse(localStorage.getItem("nexora_chats") || "[]"), current: [], sending: false };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
function formatText(text) {
    return escapeHtml(text).replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>").replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
}
function timestamp() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function addMessage(text, sender, files = [], time = timestamp()) {
    const message = document.createElement("article");
    message.className = `message ${sender}`;
    const timeMarkup = window.NexoraSettings?.get("timestamps") === false ? "" : `<time>${time}</time>`;
    message.innerHTML = `<div class="message-meta">${sender === "bot" ? "✦ Nexora AI" : "You"} ${timeMarkup}</div><div class="message-content">${formatText(text)}</div>`;
    if (files.length) {
        const list = document.createElement("div");
        list.className = "message-files";
        files.forEach((file) => { const item = document.createElement("span"); item.textContent = `📎 ${file.name}`; list.appendChild(item); });
        message.appendChild(list);
    }
    chat.appendChild(message);
    if (window.NexoraSettings?.get("scroll")) chat.scrollTop = chat.scrollHeight;
}
function saveConversation() {
    if (!state.current.length) return;
    const title = state.current.find((item) => item.sender === "user")?.text.slice(0, 42) || "New conversation";
    const existing = state.conversations.findIndex((item) => item.id === state.current.id);
    const record = { id: state.current.id || crypto.randomUUID(), title, messages: state.current };
    state.current.id = record.id;
    if (existing >= 0) state.conversations[existing] = record; else state.conversations.unshift(record);
    localStorage.setItem("nexora_chats", JSON.stringify(state.conversations.slice(0, 50)));
    renderConversations();
}
function renderConversations(filter = "") {
    const list = document.getElementById("convoList");
    list.innerHTML = "";
    state.conversations.filter((item) => `${item.title} ${item.messages.map((m) => m.text).join(" ")}`.toLowerCase().includes(filter.toLowerCase())).forEach((item) => {
        const button = document.createElement("button"); button.className = "convo-item"; button.textContent = item.title; button.onclick = () => loadConversation(item); list.appendChild(button);
    });
}
function loadConversation(record) {
    chat.innerHTML = ""; state.current = record.messages; state.current.id = record.id;
    state.current.forEach((message) => addMessage(message.text, message.sender, [], message.time));
}
function newChat() { chat.innerHTML = ""; state.current = []; state.files = []; renderAttachments(); addMessage("Welcome to Nexora AI. Ask a question or attach a file to get started.", "bot"); }
function renderAttachments() {
    attachmentPreview.innerHTML = "";
    state.files.forEach((file, index) => {
        const item = document.createElement("div"); item.className = "attachment-card";
        const icon = file.type.startsWith("image/") && window.NexoraSettings?.get("preview") ? `<img src="${URL.createObjectURL(file)}" alt="">` : `<span class="file-icon">${file.type.includes("pdf") ? "PDF" : "📄"}</span>`;
        item.innerHTML = `${icon}<span class="attachment-name">${escapeHtml(file.name)}<small>${(file.size / 1024 / 1024).toFixed(2)} MB</small></span><button type="button" aria-label="Remove ${escapeHtml(file.name)}">×</button>`;
        item.querySelector("button").onclick = () => { state.files.splice(index, 1); renderAttachments(); updateSendState(); };
        attachmentPreview.appendChild(item);
    });
}
function updateSendState() { sendBtn.disabled = state.sending || (!input.value.trim() && !state.files.length); }
function setSending(value) { state.sending = value; sendBtn.disabled = value; sendBtn.innerHTML = value ? '<span class="spinner"></span>' : "<span>Send</span> ↑"; if (!value) updateSendState(); }
async function sendMessage() {
    if (state.sending || (!input.value.trim() && !state.files.length)) return;
    const text = input.value.trim(); const files = [...state.files];
    addMessage(text || "Please analyze these files.", "user", files);
    state.current.push({ text: text || "Please analyze these files.", sender: "user", time: timestamp() });
    input.value = ""; state.files = []; renderAttachments(); setSending(true);
    const bot = document.createElement("article"); bot.className = "message bot"; bot.innerHTML = '<div class="message-meta">✦ Nexora AI</div><div class="message-content thinking">Thinking<span>.</span><span>.</span><span>.</span></div>'; chat.appendChild(bot);
    try {
        let reply = "";
        if (!files.length && window.NexoraSettings.get("stream")) {
            const es = new EventSource(`/stream?message=${encodeURIComponent(text)}&model=${encodeURIComponent(modelSelect.value)}&responseStyle=${encodeURIComponent(window.NexoraSettings.get("responseStyle"))}`);
            await new Promise((resolve, reject) => { es.onmessage = (event) => { const payload = JSON.parse(event.data); if (payload.type === "partial") { reply += payload.text; bot.querySelector(".message-content").innerHTML = formatText(reply); } if (payload.type === "done") { es.close(); resolve(); } if (payload.type === "error") { es.close(); reject(new Error(payload.message)); } }; es.onerror = () => { es.close(); reject(new Error("network")); }; });
        } else {
            const form = new FormData(); form.append("message", text); form.append("model", modelSelect.value); form.append("responseStyle", window.NexoraSettings.get("responseStyle")); files.forEach((file) => form.append("attachments", file, file.name));
            const response = await fetch("/chat", { method: "POST", body: form }); const data = await response.json(); if (!response.ok) throw new Error(data.reply);
            reply = data.reply; bot.querySelector(".message-content").innerHTML = formatText(reply);
        }
        bot.querySelector(".message-meta").innerHTML += ` <time>${timestamp()}</time>`;
        state.current.push({ text: reply, sender: "bot", time: timestamp() }); saveConversation();
    } catch (error) { bot.querySelector(".message-content").textContent = error.message === "network" ? "Nexora AI is having trouble connecting. Please check your connection and try again." : error.message; }
    finally { setSending(false); }
}
document.getElementById("attachBtn").onclick = () => fileInput.click();
fileInput.onchange = () => { state.files.push(...Array.from(fileInput.files)); fileInput.value = ""; renderAttachments(); updateSendState(); };
input.oninput = updateSendState;
input.onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey && window.NexoraSettings.get("enter")) { event.preventDefault(); sendMessage(); } };
sendBtn.onclick = sendMessage;
document.getElementById("newChatBtn").onclick = newChat;
document.getElementById("searchChats").oninput = (event) => renderConversations(event.target.value);
document.getElementById("mobileMenuBtn").onclick = () => document.getElementById("sidebar").classList.toggle("open");
(async function init() {
    try { const config = await fetch("/config").then((response) => response.json()); modelSelect.innerHTML = config.models.map((model) => `<option value="${model}">${model.replace("gemini-", "Gemini ")}</option>`).join(""); } catch { modelSelect.innerHTML = '<option value="gemini-3.6-flash">Gemini Flash</option>'; }
    const saved = localStorage.getItem("nexora_selected_model"); if (saved && [...modelSelect.options].some((option) => option.value === saved)) modelSelect.value = saved;
    modelSelect.onchange = () => { localStorage.setItem("nexora_selected_model", modelSelect.value); document.getElementById("statusModel").textContent = modelSelect.options[modelSelect.selectedIndex].text; };
    modelSelect.onchange(); renderConversations(); newChat();
})();
