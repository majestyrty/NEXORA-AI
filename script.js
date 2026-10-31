const chat = document.getElementById("chat");
const input = document.getElementById("message");
const sendBtn = document.getElementById("sendBtn");
const fileInput = document.getElementById("fileInput");
const attachmentPreview = document.getElementById("attachmentPreview");
const modelSelect = document.getElementById("modelSelect");
const state = { files: [], conversations: JSON.parse(localStorage.getItem("nexora_chats") || "[]"), current: [], sending: false, config: null, user: null, provider: "gemini", authMode: "login", pendingSignup: null, emailAuthSession: null, headlineTimer: null, welcomeAnimation: null, pricingCountry: localStorage.getItem("nexora_pricing_country") || "US", pricingRequestId: 0, billingPlan: null, pendingPayment: null };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
function formatText(text) { return escapeHtml(text).replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>").replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>"); }
function timestamp() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function conversationTitle(record) {
    const firstMessage = record.messages.find((item) => item.sender === "user")?.text?.trim();
    if (!firstMessage) return record.title || "New conversation";
    if (/^(hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening|thanks|thank you)[!.?,\s]*$/i.test(firstMessage)) return "Getting started";
    return firstMessage.slice(0, 42);
}
function stopWelcomeParticles() {
    if (!state.welcomeAnimation) return;
    cancelAnimationFrame(state.welcomeAnimation.frame);
    state.welcomeAnimation.observer.disconnect();
    state.welcomeAnimation = null;
}
function startWelcomeParticles(canvas) {
    if (window.NexoraSettings?.get("particles") === false || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = canvas.getContext("2d");
    const particles = Array.from({ length: 42 }, () => ({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - .5) * .00055,
        vy: (Math.random() - .5) * .00055,
        size: Math.random() * 1.6 + .6
    }));
    const resize = () => {
        const bounds = canvas.getBoundingClientRect();
        const scale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(bounds.width * scale);
        canvas.height = Math.round(bounds.height * scale);
        context.setTransform(scale, 0, 0, scale, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    const animation = { frame: 0, observer };
    state.welcomeAnimation = animation;
    const animate = () => {
        if (state.welcomeAnimation !== animation) return;
        const bounds = canvas.getBoundingClientRect();
        context.clearRect(0, 0, bounds.width, bounds.height);
        particles.forEach((particle, index) => {
            particle.x += particle.vx;
            particle.y += particle.vy;
            if (particle.x < 0 || particle.x > 1) particle.vx *= -1;
            if (particle.y < 0 || particle.y > 1) particle.vy *= -1;
            const x = particle.x * bounds.width;
            const y = particle.y * bounds.height;
            context.fillStyle = "rgba(108, 190, 255, .78)";
            context.beginPath();
            context.arc(x, y, particle.size, 0, Math.PI * 2);
            context.fill();
            particles.slice(index + 1).forEach((other) => {
                const dx = (particle.x - other.x) * bounds.width;
                const dy = (particle.y - other.y) * bounds.height;
                const distance = Math.hypot(dx, dy);
                if (distance < 100) {
                    context.strokeStyle = `rgba(77, 155, 244, ${.16 * (1 - distance / 100)})`;
                    context.lineWidth = 1;
                    context.beginPath();
                    context.moveTo(x, y);
                    context.lineTo(other.x * bounds.width, other.y * bounds.height);
                    context.stroke();
                }
            });
        });
        animation.frame = requestAnimationFrame(animate);
    };
    animate();
}
function renderPricing(pricing) {
    const grid = document.getElementById("pricingGrid");
    if (!grid) return;
    grid.replaceChildren();
    pricing.plans.forEach((plan) => {
        const card = document.createElement("article");
        card.className = `pricing-card${plan.id === "pro" ? " featured" : ""}`;
        const name = document.createElement("h3");
        name.textContent = plan.name;
        const price = document.createElement("p");
        price.className = "pricing-amount";
        price.textContent = new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: pricing.currency,
            maximumFractionDigits: 2
        }).format(plan.monthlyPrice);
        const cadence = document.createElement("span");
        cadence.className = "pricing-cadence";
        cadence.textContent = "/ month";
        price.append(" ", cadence);
        const basePrice = document.createElement("p");
        basePrice.className = "pricing-base";
        basePrice.textContent = `$${plan.usdMonthly} USD base price`;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pricing-cta";
        button.textContent = pricing.checkoutAvailable ? "Pay for one month" : "Checkout unavailable";
        button.disabled = !pricing.checkoutAvailable;
        button.onclick = () => {
            openBillingDialog(plan, pricing);
        };
        card.append(name, price, basePrice, button);
        grid.appendChild(card);
    });
}
async function loadPricing(countryCode = state.pricingCountry) {
    const status = document.getElementById("pricingStatus");
    const countrySelect = document.getElementById("pricingCountry");
    if (!status || !countrySelect) return;
    const requestId = ++state.pricingRequestId;
    status.textContent = "Loading local pricing…";
    try {
        const response = await fetch(`/api/pricing?country=${encodeURIComponent(countryCode)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Unable to load pricing.");
        if (requestId !== state.pricingRequestId) return;
        if (!countrySelect.options.length) {
            data.countries.forEach((country) => {
                const option = document.createElement("option");
                option.value = country.code;
                option.textContent = country.name;
                countrySelect.appendChild(option);
            });
        }
        countrySelect.value = data.country.code;
        state.pricingCountry = data.country.code;
        localStorage.setItem("nexora_pricing_country", state.pricingCountry);
        renderPricing(data);
        const methodSummary = data.checkoutMessage;
        status.textContent = data.currency === "USD"
            ? `${methodSummary} Prices shown in USD. Taxes may vary by location.`
            : `${methodSummary} Approximate ${data.currency} prices converted from USD. Taxes may vary by location.`;
    } catch (error) {
        if (requestId !== state.pricingRequestId) return;
        status.textContent = error.message || "Unable to load pricing. Please try again.";
    }
}
function openBillingDialog(plan, pricing) {
    const dialog = document.getElementById("billingDialog");
    state.billingPlan = plan;
    document.getElementById("checkoutPlanSummary").textContent =
        `${plan.name} · ${new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: pricing.currency,
            maximumFractionDigits: 2
        }).format(plan.monthlyPrice)} for one month (${pricing.country.name})`;
    document.getElementById("billingEmail").value = state.user?.email || "";
    document.getElementById("checkoutError").textContent = "";
    const submit = document.getElementById("checkoutSubmit");
    submit.disabled = !pricing.checkoutAvailable;
    submit.textContent = pricing.checkoutAvailable
        ? "Continue to secure payment"
        : "Checkout unavailable";
    dialog.showModal();
}
async function beginCheckout(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!state.billingPlan || !form.reportValidity()) return;
    const submit = document.getElementById("checkoutSubmit");
    const error = document.getElementById("checkoutError");
    submit.disabled = true;
    submit.textContent = "Connecting to Paystack…";
    error.textContent = "";
    try {
        const response = await fetch("/api/checkout", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                planId: state.billingPlan.id,
                country: state.pricingCountry,
                email: document.getElementById("billingEmail").value.trim()
            })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Unable to start checkout.");
        const checkoutUrl = new URL(result.checkoutUrl);
        if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.paystack.com") {
            throw new Error("The payment provider returned an invalid checkout link.");
        }
        window.location.assign(checkoutUrl.toString());
    } catch (requestError) {
        error.textContent = requestError.message || "Unable to start checkout. Please try again.";
        submit.disabled = false;
        submit.textContent = "Continue to secure payment";
    }
}
async function verifyCheckout(reference) {
    const status = document.getElementById("pricingStatus");
    const checkButton = document.getElementById("checkPaymentButton");
    if (checkButton) {
        checkButton.disabled = true;
        checkButton.textContent = "Checking payment…";
    }
    try {
        const response = await fetch("/api/checkout/verify", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reference })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Unable to verify this payment.");
        if (result.status === "successful") {
            state.pendingPayment = null;
            status.textContent = `Payment confirmed. ${result.planName} is paid for one month. No automatic renewal.`;
            if (checkButton) checkButton.hidden = true;
        } else if (result.status === "failed") {
            state.pendingPayment = null;
            status.textContent = result.message;
            if (checkButton) checkButton.hidden = true;
        } else {
            state.pendingPayment = { reference };
            status.textContent = result.message;
            if (checkButton) {
                checkButton.hidden = false;
                checkButton.disabled = false;
                checkButton.textContent = "Check payment status";
            }
        }
    } catch (error) {
        status.textContent = error.message || "Unable to verify this payment.";
        if (checkButton) {
            checkButton.hidden = false;
            checkButton.disabled = false;
            checkButton.textContent = "Try checking again";
        }
    }
}
function processPaymentReturn() {
    const url = new URL(window.location.href);
    if (url.searchParams.get("payment") !== "return") return;
    const reference = url.searchParams.get("reference") || url.searchParams.get("trxref") || "";
    url.searchParams.delete("payment");
    url.searchParams.delete("reference");
    url.searchParams.delete("trxref");
    url.searchParams.delete("status");
    window.history.replaceState({}, "", url);
    if (!reference) {
        document.getElementById("pricingStatus").textContent =
            "We could not verify the payment redirect. Choose a plan to try again or contact support.";
        return;
    }
    verifyCheckout(reference);
}
function addMessage(text, sender, files = [], time = timestamp()) {
    const message = document.createElement("article"); message.className = `message ${sender}`;
    const timeMarkup = window.NexoraSettings?.get("timestamps") === false ? "" : `<time>${time}</time>`;
    message.innerHTML = `<div class="message-meta">${sender === "bot" ? "✦ Nexora AI" : "You"} ${timeMarkup}</div><div class="message-content">${formatText(text)}</div>`;
    if (files.length) { const list = document.createElement("div"); list.className = "message-files"; files.forEach((file) => { const item = document.createElement("span"); item.textContent = `📎 ${file.name}`; list.appendChild(item); }); message.appendChild(list); }
    chat.appendChild(message); if (window.NexoraSettings?.get("scroll")) chat.scrollTop = chat.scrollHeight;
}
function saveConversation() {
    if (!state.current.length) return;
    const title = conversationTitle({ messages: state.current, title: "New conversation" });
    const record = { id: state.current.id || crypto.randomUUID(), title, messages: state.current }; state.current.id = record.id;
    const existing = state.conversations.findIndex((item) => item.id === record.id); if (existing >= 0) state.conversations[existing] = record; else state.conversations.unshift(record);
    localStorage.setItem("nexora_chats", JSON.stringify(state.conversations.slice(0, 50))); renderConversations();
}
function renderConversations(filter = "") {
    const list = document.getElementById("convoList"); list.innerHTML = "";
    state.conversations.filter((item) => `${conversationTitle(item)} ${item.messages.map((m) => m.text).join(" ")}`.toLowerCase().includes(filter.toLowerCase())).forEach((item) => { const button = document.createElement("button"); button.className = "convo-item"; button.textContent = conversationTitle(item); if (item.id === state.current.id) { button.classList.add("active"); button.setAttribute("aria-current", "page"); } button.onclick = () => loadConversation(item); list.appendChild(button); });
}
function loadConversation(record) { stopWelcomeParticles(); chat.innerHTML = ""; state.current = record.messages; state.current.id = record.id; state.current.forEach((message) => addMessage(message.text, message.sender, [], message.time)); renderConversations(document.getElementById("searchChats").value); document.getElementById("sidebar").classList.remove("open"); }
function renderWelcome() {
    const firstName = state.user?.name?.trim().split(/\s+/)[0];
    chat.innerHTML = `<section class="welcome-screen" aria-label="Start a conversation">
        <canvas class="welcome-particles" aria-hidden="true"></canvas>
        <div class="welcome-content">
            <span class="welcome-kicker">YOUR AI WORKSPACE</span>
            <h2>${firstName ? `Welcome, ${escapeHtml(firstName)}.` : "What can we explore today?"}</h2>
            <p class="welcome-description">Think through an idea, create something new, or bring a file into the conversation.</p>
            <div class="prompt-suggestions" aria-label="Suggested prompts">
                <button type="button" data-prompt="Help me brainstorm a fresh idea for a project.">✦ Brainstorm an idea</button>
                <button type="button" data-prompt="Help me write a clear, engaging first draft.">✎ Write a first draft</button>
                <button type="button" data-prompt="I have a file to understand. What can you help me find in it?">⌕ Explore a file</button>
            </div>
            <div class="pricing-heading">
                <div><span class="welcome-kicker">SIMPLE MONTHLY PLANS</span><h3>Choose your Nexora plan</h3></div>
                <label for="pricingCountry">Country
                    <select id="pricingCountry" aria-label="Choose your country for pricing"></select>
                </label>
            </div>
            <div id="pricingGrid" class="pricing-grid" aria-live="polite"></div>
            <p id="pricingStatus" class="pricing-status" role="status">Loading local pricing…</p>
            <button id="checkPaymentButton" class="check-payment-button" type="button" hidden>Check payment status</button>
        </div>
    </section>`;
    startWelcomeParticles(chat.querySelector(".welcome-particles"));
    chat.querySelectorAll("[data-prompt]").forEach((button) => {
        button.addEventListener("click", () => {
            input.value = button.dataset.prompt;
            updateSendState();
            input.focus();
        });
    });
    chat.querySelector("#pricingCountry").addEventListener("change", (event) => loadPricing(event.target.value));
    chat.querySelector("#checkPaymentButton").addEventListener("click", () => {
        if (state.pendingPayment) {
            verifyCheckout(state.pendingPayment.reference);
        }
    });
    loadPricing(state.pricingCountry);
}
function newChat() { stopWelcomeParticles(); chat.innerHTML = ""; state.current = []; state.files = []; input.value = ""; document.getElementById("fileError").textContent = ""; renderAttachments(); renderConversations(document.getElementById("searchChats").value); document.getElementById("sidebar").classList.remove("open"); renderWelcome(); }
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
function showAuthScreen(message = "") { document.body.classList.add("auth-checking"); document.getElementById("appLoader").hidden = true; document.getElementById("authScreen").hidden = false; document.getElementById("authError").textContent = message; animateWelcomeHeadline(); }
function showApp() { document.body.classList.remove("auth-checking"); document.getElementById("appLoader").hidden = true; document.getElementById("authScreen").hidden = true; }
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
    processPaymentReturn();
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
function renderMicrosoftButton() {
    const button = document.getElementById("microsoftSignInButton");
    const label = document.getElementById("microsoftSignInLabel");
    if (!button || !label) return;
    const configured = Boolean(state.config?.microsoftConfigured);
    button.disabled = !configured;
    button.title = configured
        ? ""
        : "Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET on the server to enable Microsoft sign-in.";
    label.textContent = configured
        ? state.authMode === "signup" ? "Sign up with Microsoft" : "Continue with Microsoft"
        : "Microsoft sign-in unavailable";
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
    renderMicrosoftButton();
    document.getElementById("emailAuthButton").textContent = signingUp ? "Create account with email" : "Continue with email";
    document.getElementById("emailAuthHint").textContent = "We will send a 6-digit code to your email.";
    document.getElementById("otpFields").hidden = true;
    document.getElementById("verifyOtpButton").hidden = true;
    document.getElementById("otpInput").value = "";
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
async function beginMicrosoftSignIn() {
    const signup = {};
    if (state.authMode === "signup") {
        signup.name = document.getElementById("signupName").value.trim();
        signup.age = Number(document.getElementById("signupAge").value);
        if (!signup.name || signup.name.length > 80) {
            document.getElementById("authError").textContent = "Enter your name (up to 80 characters) to sign up.";
            document.getElementById("signupName").focus();
            return;
        }
        if (!Number.isInteger(signup.age) || signup.age < 1 || signup.age > 120) {
            document.getElementById("authError").textContent = "Enter a valid age between 1 and 120 to sign up.";
            document.getElementById("signupAge").focus();
            return;
        }
    }

    const button = document.getElementById("microsoftSignInButton");
    button.disabled = true;
    document.getElementById("authError").textContent = "";
    try {
        const response = await fetch("/auth/microsoft/start", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: state.authMode, signup })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Unable to start Microsoft sign-in.");
        window.location.assign(data.authorizeUrl);
    } catch (error) {
        document.getElementById("authError").textContent = error.message || "Microsoft sign-in failed. Please try again.";
        button.disabled = !state.config?.microsoftConfigured;
    }
}
function getMicrosoftAuthError() {
    const code = new URLSearchParams(window.location.search).get("auth_error");
    const messages = {
        microsoft_state: "Microsoft sign-in expired or could not be verified. Please try again.",
        microsoft_denied: "Microsoft sign-in was cancelled.",
        microsoft_exchange: "Microsoft sign-in could not be completed. Please try again.",
        microsoft_email: "Microsoft did not provide a valid email address for this account.",
        microsoft_session: "Unable to create a secure sign-in session. Please try again.",
        microsoft_failed: "Microsoft sign-in failed. Please try again."
    };
    return messages[code] || "";
}
async function beginEmailAuth() {
    const emailInput = document.getElementById("emailInput");
    const passwordInput = document.getElementById("passwordInput");
    const signupNameInput = document.getElementById("signupName");
    const signupAgeInput = document.getElementById("signupAge");
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const mode = state.authMode;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        document.getElementById("authError").textContent = "Enter a valid email address.";
        emailInput.focus();
        return;
    }
    if (password.length < 8 || password.length > 128) {
        document.getElementById("authError").textContent = "Choose a password between 8 and 128 characters.";
        passwordInput.focus();
        return;
    }

    if (mode === "signup") {
        const name = signupNameInput.value.trim();
        const age = Number(signupAgeInput.value);
        if (!name || name.length > 80) {
            document.getElementById("authError").textContent = "Enter your name (up to 80 characters) to sign up.";
            signupNameInput.focus();
            return;
        }
        if (!Number.isInteger(age) || age < 1 || age > 120) {
            document.getElementById("authError").textContent = "Enter a valid age between 1 and 120 to sign up.";
            signupAgeInput.focus();
            return;
        }
    }

    const submitButton = document.getElementById("emailAuthButton");
    submitButton.disabled = true;
    submitButton.textContent = "Sending code...";
    document.getElementById("authError").textContent = "";

    try {
        const response = await fetch("/auth/email/start", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode,
                email,
                password,
                name: signupNameInput.value.trim(),
                age: Number(signupAgeInput.value)
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Unable to send verification code.");

        const otpFields = document.getElementById("otpFields");
        const verifyButton = document.getElementById("verifyOtpButton");
        otpFields.hidden = false;
        verifyButton.hidden = false;
        document.getElementById("emailAuthHint").textContent = data.debugCode
            ? `Code sent. Demo verification code: ${data.debugCode}`
            : data.message;
        document.getElementById("otpInput").focus();
        state.emailAuthSession = { email, mode };
    } catch (error) {
        document.getElementById("authError").textContent = error.message || "Unable to send a verification code.";
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = state.authMode === "signup" ? "Create account with email" : "Continue with email";
    }
}
async function verifyEmailCode() {
    const otpInput = document.getElementById("otpInput");
    const code = otpInput.value.trim();
    const session = state.emailAuthSession;

    if (!session) {
        document.getElementById("authError").textContent = "Please request a verification code first.";
        return;
    }
    if (!/^\d{6}$/.test(code)) {
        document.getElementById("authError").textContent = "Enter the 6-digit verification code.";
        otpInput.focus();
        return;
    }

    const verifyButton = document.getElementById("verifyOtpButton");
    verifyButton.disabled = true;
    verifyButton.textContent = "Verifying...";
    document.getElementById("authError").textContent = "";

    try {
        const response = await fetch("/auth/email/verify", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: session.email, code })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Unable to verify the code.");
        state.emailAuthSession = null;
        redirectToChat();
    } catch (error) {
        document.getElementById("authError").textContent = error.message || "Verification failed.";
    } finally {
        verifyButton.disabled = false;
        verifyButton.textContent = "Verify code";
    }
}
async function handleUnauthorized() { state.user = null; showAuthScreen("Your session expired. Please sign in again."); if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect(); renderGoogleButton(); renderMicrosoftButton(); }
async function loadConfig() {
    state.config = await fetchWithTimeout("/config").then((response) => response.json());
    const savedProvider = localStorage.getItem("nexora_provider") || "gemini"; state.provider = state.config.providers[savedProvider] ? savedProvider : Object.keys(state.config.providers)[0];
    populateModels(localStorage.getItem(`nexora_selected_model_${state.provider}`) || localStorage.getItem("nexora_selected_model"));
}
function populateModels(preferred) {
    const models = state.config.providers[state.provider].models; modelSelect.innerHTML = models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("");
    modelSelect.value = models.includes(preferred) ? preferred : models[0]; localStorage.setItem("nexora_provider", state.provider); localStorage.setItem(`nexora_selected_model_${state.provider}`, modelSelect.value); localStorage.setItem("nexora_selected_model", modelSelect.value);
    document.getElementById("statusModel").textContent = providerModelLabel();
    const providerSelect = document.getElementById("providerSelect"); if (providerSelect) providerSelect.value = state.provider;
    const settingsModels = document.getElementById("settingsModelSelect"); if (settingsModels) { settingsModels.innerHTML = models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join(""); settingsModels.value = modelSelect.value; }
}
async function sendMessage() {
    if (state.sending || (!input.value.trim() && !state.files.length)) return;
    stopWelcomeParticles();
    chat.querySelector(".welcome-screen")?.remove();
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
    const maxSize = (state.config?.maxFileSize || 20 * 1024 * 1024);
    const selected = Array.from(fileInput.files);
    const oversized = selected.find((file) => file.size > maxSize);
    if (oversized) {
        document.getElementById("fileError").textContent = `${oversized.name} is too large. Files must be 20 MB or smaller.`;
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
document.getElementById("modelSelect").onchange = () => { localStorage.setItem(`nexora_selected_model_${state.provider}`, modelSelect.value); localStorage.setItem("nexora_selected_model", modelSelect.value); document.getElementById("statusModel").textContent = providerModelLabel(); document.getElementById("settingsModelSelect").value = modelSelect.value; };
window.addEventListener("nexora-provider-change", (event) => { state.provider = event.detail; populateModels(localStorage.getItem(`nexora_selected_model_${state.provider}`)); });
document.getElementById("logoutBtn").onclick = () => document.getElementById("settingsLogoutBtn").click();
document.getElementById("loginModeButton").onclick = () => setAuthMode("login");
document.getElementById("signupModeButton").onclick = () => setAuthMode("signup");
document.getElementById("emailAuthButton").onclick = beginEmailAuth;
document.getElementById("verifyOtpButton").onclick = verifyEmailCode;
document.getElementById("passwordInput").onkeydown = (event) => { if (event.key === "Enter") { if (document.getElementById("otpFields").hidden) beginEmailAuth(); else verifyEmailCode(); } };
document.getElementById("otpInput").onkeydown = (event) => { if (event.key === "Enter") verifyEmailCode(); };
document.getElementById("googleSignInButton").onclick = beginGoogleSignIn;
document.getElementById("microsoftSignInButton").onclick = beginMicrosoftSignIn;
window.addEventListener("nexora-particles-change", (event) => {
    const canvas = chat.querySelector(".welcome-particles");
    if (!canvas) return;
    stopWelcomeParticles();
    if (event.detail) startWelcomeParticles(canvas);
});
document.getElementById("billingForm").addEventListener("submit", beginCheckout);
document.getElementById("closeBilling").addEventListener("click", () => {
    document.getElementById("billingDialog").close();
});
document.getElementById("billingDialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
});

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
            renderMicrosoftButton();
            const microsoftAuthError = getMicrosoftAuthError();
            if (microsoftAuthError) {
                document.getElementById("authError").textContent = microsoftAuthError;
                window.history.replaceState({}, document.title, window.location.pathname);
            }
            return;
        }
        const data = await session.json(); await enterApp(data.user);
    } catch (error) { showAuthScreen("Unable to connect to Nexora AI. Please refresh and try again."); }
})();
