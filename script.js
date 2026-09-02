const chat = document.getElementById("chat");
const input = document.getElementById("message");
const sendBtn = document.getElementById("sendBtn");

function addMessage(text, sender) {
    const message = document.createElement("article");
    message.className = `message ${sender}`;
    message.innerHTML = text.replace(/\n/g, "<br>");
    chat.appendChild(message);
    chat.scrollTop = chat.scrollHeight;
}

function addTyping() {
    const typing = document.createElement("article");
    typing.className = "message bot";
    typing.id = "typing";
    typing.innerHTML = "🤖 Nexora AI is thinking...";
    chat.appendChild(typing);
    chat.scrollTop = chat.scrollHeight;
}

function removeTyping() {
    const typing = document.getElementById("typing");
    if (typing) {
        typing.remove();
    }
}

function setSending(isSending) {
    if (!sendBtn) return;
    sendBtn.disabled = isSending;
    if (isSending) {
        sendBtn.classList.add('sending');
        sendBtn.innerHTML = '<span class="n-badge">N</span>';
    } else {
        sendBtn.classList.remove('sending');
        sendBtn.innerHTML = '<span>Ask Nexora</span>';
    }
}

async function sendMessage() {
    const messageText = input.value.trim();
    if (!messageText) {
        input.focus();
        return;
    }

    addMessage(messageText, "user");
    input.value = "";
    input.focus();
    setSending(true);

    // create a bot message container for streaming text
    const botMessage = document.createElement('article');
    botMessage.className = 'message bot';
    botMessage.id = 'botReply';
    botMessage.innerHTML = '';
    chat.appendChild(botMessage);
    chat.scrollTop = chat.scrollHeight;

    // Try Server-Sent Events streaming endpoint (GET /stream?message=...)
    let es;
    try {
        const url = '/stream?message=' + encodeURIComponent(messageText);
        es = new EventSource(url);

        es.onmessage = (e) => {
            try {                const payload = JSON.parse(e.data);
                if (payload.type === 'partial') {                    // append partial text                    const existing = botMessage.innerHTML || '';                    botMessage.innerHTML = (existing + payload.text).replace(/\n/g, '<br>');                    chat.scrollTop = chat.scrollHeight;                } else if (payload.type === 'done') {                    es.close();                    setSending(false);                } else if (payload.type === 'error') {                    es.close();                    botMessage.innerHTML = '❌ ' + (payload.message || 'Error from server');                    setSending(false);                }            } catch (err) {                console.error('Failed to parse SSE data', err);            }        };

        es.onerror = (err) => {            console.error('SSE error', err);            if (es) es.close();            // fallback: request non-streaming chat endpoint            fetch('/chat', {                method: 'POST',                headers: { 'Content-Type': 'application/json' },                body: JSON.stringify({ message: messageText }),            }).then(r=>r.json()).then(data=>{                if (data && data.reply) botMessage.innerHTML = data.reply.replace(/\n/g, '<br>');                else botMessage.innerHTML = '❌ Unable to get reply.';            }).catch(()=>{                botMessage.innerHTML = '❌ Unable to connect to Nexora AI. Please try again later.';            }).finally(()=> setSending(false));        };

    } catch (err) {        console.error('Streaming not supported, falling back', err);        // fallback to regular POST /chat        try {            const response = await fetch('/chat', {                method: 'POST',                headers: { 'Content-Type': 'application/json' },                body: JSON.stringify({ message: messageText }),            });            const data = await response.json();            botMessage.innerHTML = (data && data.reply) ? data.reply.replace(/\n/g, '<br>') : '❌ Invalid server response';        } catch (e) {            botMessage.innerHTML = '❌ Unable to connect to Nexora AI. Please try again later.';            console.error(e);        } finally {            setSending(false);        }    }
}

sendBtn?.addEventListener("click", sendMessage);
input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
});
