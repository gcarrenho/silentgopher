// firebase-most-read.js
import { getDatabase, ref, query, orderByChild, limitToLast, get } from "firebase/database";

export function loadMostReadPosts() {
    const db = getDatabase();
    const mostReadRef = query(
        ref(db, 'visitas'),
        orderByChild('count'),
        limitToLast(5) // Muestra los 5 más leídos
    );

    get(mostReadRef).then((snapshot) => {
        const posts = [];
        snapshot.forEach((childSnapshot) => {
            posts.push({
                id: childSnapshot.key,
                ...childSnapshot.val()
            });
        });

        // Ordena de mayor a menor
        posts.sort((a, b) => b.count - a.count);

        renderMostReadPosts(posts);
    }).catch((error) => {
        console.error("Error cargando posts más leídos:", error);
        document.getElementById('most-read-posts').innerHTML =
            '<li>Error cargando los más leídos</li>';
    });
}

function renderMostReadPosts(posts) {
    const container = document.getElementById('most-read-posts');

    if (posts.length === 0) {
        container.innerHTML = '<li>No hay datos de visitas aún</li>';
        return;
    }

    container.innerHTML = posts.map(post => `
        <li>
            <a href="/posts/${post.slug || post.id}">${post.title}</a>
            <span class="post-meta">
                <span class="post-views">
                    <svg class="icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                    </svg>
                    ${post.count || 0}
                </span>
            </span>
        </li>
    `).join('');
}

function getCurrentLangPrefix() {
    return window.location.pathname.startsWith("/en/") ? "/en" : "/es";
}

// Inicializa cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', loadMostReadPosts);