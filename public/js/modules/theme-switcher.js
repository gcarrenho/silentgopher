export function initThemeSwitcher() {
    document.addEventListener('DOMContentLoaded', () => {
        // Selecciona TODOS los botones de tema (para funcionar en cualquier página)
        const themeToggles = document.querySelectorAll('.theme-toggle');

        // Detectar preferencia del sistema
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const currentTheme = localStorage.getItem('theme');

        // Aplicar tema inicial
        if (currentTheme === 'dark' || (!currentTheme && prefersDark)) {
            document.documentElement.setAttribute('data-theme', 'dark');
            themeToggles.forEach(btn => btn.textContent = '☀️');
        } else {
            document.documentElement.setAttribute('data-theme', 'light');
            themeToggles.forEach(btn => btn.textContent = '🌙');
        }

        // Configurar event listeners para todos los botones
        themeToggles.forEach(button => {
            button.addEventListener('click', () => {
                const current = document.documentElement.getAttribute('data-theme');
                if (current === 'light') {
                    document.documentElement.setAttribute('data-theme', 'dark');
                    themeToggles.forEach(btn => btn.textContent = '☀️');
                    localStorage.setItem('theme', 'dark');
                } else {
                    document.documentElement.setAttribute('data-theme', 'light');
                    themeToggles.forEach(btn => btn.textContent = '🌙');
                    localStorage.setItem('theme', 'light');
                }
            });
        });

        // Escuchar cambios en la preferencia del sistema
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            if (!localStorage.getItem('theme')) {
                const newTheme = e.matches ? 'dark' : 'light';
                document.documentElement.setAttribute('data-theme', newTheme);
                themeToggles.forEach(btn => btn.textContent = newTheme === 'dark' ? '☀️' : '🌙');
            }
        });
    });
}
