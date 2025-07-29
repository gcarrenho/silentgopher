import { trackClap, loadClaps } from './analytics.js';

export async function setupClapCounter(postId) {
    const clapBtn = document.getElementById('clap-btn');
    const clapCount = document.getElementById('clap-count');

    if (clapBtn && clapCount) {
        // ✅ Cargar y mostrar aplausos al inicio
        const count = await loadClaps(postId);
        clapCount.textContent = count;

        clapBtn.addEventListener('click', () => {
            trackClap(postId);

            // Actualiza el número mostrado localmente (sin esperar Firebase)
            let current = parseInt(clapCount.textContent, 10) || 0;
            clapCount.textContent = current + 1;

            // Animación
            clapBtn.classList.add('clap-animation');
            setTimeout(() => clapBtn.classList.remove('clap-animation'), 300);
        });
    }
}
