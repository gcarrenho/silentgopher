import { setupClapCounter } from './modules/claps.js';
import { trackView, getMostReadPosts } from './modules/analytics.js';
import { initThemeSwitcher } from './modules/theme-switcher.js';
import { setupComments } from './modules/comments.js';

document.addEventListener('DOMContentLoaded', () => {
    const body = document.body;
    const postId = body.dataset.postId || 'default';
    const title = document.title;

    initThemeSwitcher();
    setupClapCounter(postId);
    // Vista del home
    if (body.classList.contains('home-page')) {
        trackView('home', 'Inicio');
    }

    // ✅ Aquí se registra la vista en Firebase si estás en una página de post
    if (document.body.classList.contains('post-page')) {
        trackView(postId, title);
        setupComments(postId); // ✅ Inicializa comentarios solo en páginas de post
    }

    // ✅ Llenar el sidebar de más leídos si existe
    const mostReadList = document.getElementById('most-read-posts');

    if (mostReadList) {
        mostReadList.innerHTML = '<li class="loading">Cargando posts más leídos...</li>';

        getMostReadPosts(5)
            .then(posts => {
                if (!posts.length) {
                    mostReadList.innerHTML = '<li>No hay datos de más leídos aún.</li>';
                    return;
                }

                mostReadList.innerHTML = '';
                posts.forEach(post => {
                    const li = document.createElement('li');
                    li.innerHTML = `
                        <a href="${post.url}">${post.title}</a>
                        <span class="post-meta">👁️ ${post.count}</span>
                    `;
                    mostReadList.appendChild(li);
                });
            })
            .catch(err => {
                console.error("Error cargando posts más leídos:", err);
                mostReadList.innerHTML = '<li>Error al cargar.</li>';
            });
    }

});

