const canvas = document.createElement("canvas");
canvas.id = "particleCanvas";
document.body.appendChild(canvas);
const context = canvas.getContext("2d");
const particles = Array.from({ length: 55 }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.0015, vy: (Math.random() - 0.5) * 0.0015, size: Math.random() * 2 + 1 }));
function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
function animate() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((particle) => {
        particle.x += particle.vx; particle.y += particle.vy;
        if (particle.x < 0 || particle.x > 1) particle.vx *= -1;
        if (particle.y < 0 || particle.y > 1) particle.vy *= -1;
        context.fillStyle = "rgba(0,180,255,.7)"; context.beginPath(); context.arc(particle.x * canvas.width, particle.y * canvas.height, particle.size, 0, Math.PI * 2); context.fill();
    });
    requestAnimationFrame(animate);
}
addEventListener("resize", resize); resize(); animate();
