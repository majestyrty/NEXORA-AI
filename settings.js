const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const settingsOverlay = document.getElementById("settingsOverlay");
const closeSettings = document.getElementById("closeSettings");
const darkToggle = document.getElementById("darkToggle");
const particleToggle = document.getElementById("particleToggle");
const particleCanvas = document.getElementById("particleCanvas");

function applyTheme(darkMode) {
    document.body.classList.toggle("light-mode", !darkMode);
}

function applyParticles(enabled) {
    if (particleCanvas) {
        particleCanvas.style.display = enabled ? "block" : "none";
    }
}

function savePreferences() {
    localStorage.setItem("nexora-dark-mode", JSON.stringify(darkToggle.checked));
    localStorage.setItem("nexora-particles", JSON.stringify(particleToggle.checked));
}

function loadPreferences() {
    const savedDark = localStorage.getItem("nexora-dark-mode");
    const savedParticles = localStorage.getItem("nexora-particles");

    if (savedDark !== null) {
        darkToggle.checked = JSON.parse(savedDark);
    }

    if (savedParticles !== null) {
        particleToggle.checked = JSON.parse(savedParticles);
    }

    applyTheme(darkToggle.checked);
    applyParticles(particleToggle.checked);
}

function openSettings() {
    settingsPanel.classList.add("visible");
    settingsOverlay.classList.add("visible");
    settingsPanel.classList.remove("hidden");
    settingsOverlay.classList.remove("hidden");
}

function closeSettingsPanel() {
    settingsPanel.classList.remove("visible");
    settingsOverlay.classList.remove("visible");
    settingsPanel.classList.add("hidden");
    settingsOverlay.classList.add("hidden");
}

settingsBtn?.addEventListener("click", openSettings);
closeSettings?.addEventListener("click", closeSettingsPanel);
settingsOverlay?.addEventListener("click", closeSettingsPanel);

darkToggle?.addEventListener("change", () => {
    applyTheme(darkToggle.checked);
    savePreferences();
});

particleToggle?.addEventListener("change", () => {
    applyParticles(particleToggle.checked);
    savePreferences();
});

loadPreferences();
