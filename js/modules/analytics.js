import { db } from './firebase.js';
import { ref, get, child, increment, update, query, orderByChild, limitToLast } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-database.js";

// Contador global de visitas al sitio
const SITE_VISITS_KEY = 'site_visits';
const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

// Función para registrar visita a la página principal
export async function trackPageView() {
    try {
        if (!isDev) {
            const siteVisitsRef = ref(db, SITE_VISITS_KEY);
            await update(siteVisitsRef, {
                count: increment(1),
                lastVisit: new Date().toISOString()
            });

            // Actualizar el contador en el DOM si existe
            const totalVisitsEl = document.getElementById('total-visits');
            if (totalVisitsEl) {
                const snapshot = await get(siteVisitsRef);
                totalVisitsEl.textContent = snapshot.exists() ? snapshot.val().count : 0;
            }
        }
    } catch (error) {
        console.error('Error registrando visita al sitio:', error);
    }
}

// Función para obtener el total de visitas al sitio
export async function getTotalSiteVisits() {
    try {
        const snapshot = await get(ref(db, SITE_VISITS_KEY));
        return snapshot.exists() ? snapshot.val().count : 0;
    } catch (error) {
        console.error('Error obteniendo visitas totales:', error);
        return 0;
    }
}

export async function trackView(postId, title) {
    try {
        if (!isDev) {
            const postRef = ref(db, `posts/${postId}`);
            const snapshot = await get(postRef);

            let currentViews = 0;
            if (snapshot.exists()) {
                const data = snapshot.val();
                currentViews = data.views || 0;
            }

            /* await update(postRef, {
                 views: currentViews + 1,
                 title: title,
             });*/
            update(ref(db, `posts/${postId}`), {
                views: increment(1)
            }).catch((error) => {
                console.error("Error registrando aplauso:", error);
            });

            // Mostrar el número actualizado
            const viewCountEl = document.getElementById('view-count');
            if (viewCountEl) {
                viewCountEl.textContent = currentViews + 1;
            }
        }
    } catch (error) {
        console.error('Error registrando vista:', error);
    }
}

export function trackClap(postId) {
    if (!isDev) {
        const clapRef = ref(db, `posts/${postId}/claps`);
        update(ref(db, `posts/${postId}`), {
            claps: increment(1)
        }).catch((error) => {
            console.error("Error registrando aplauso:", error);
        });
    }
}

export async function loadClaps(postId) {
    try {
        const snapshot = await get(child(ref(db), `posts/${postId}/claps`));
        if (snapshot.exists()) {
            return snapshot.val();
        } else {
            return 0;
        }
    } catch (error) {
        console.error("Error cargando aplausos:", error);
        return 0;
    }
}



export async function getMostReadPosts(limit = 1) {
    const cacheKey = 'mostReadPostsCache';
    const cacheExpiryKey = 'mostReadPostsCacheExpiry';
    const now = Date.now();
    const currentLang = document.documentElement.lang || 'es';

    try {
        /*const cacheExpiry = localStorage.getItem(cacheExpiryKey);
        if (cacheExpiry && now < parseInt(cacheExpiry)) {
            const cachedData = JSON.parse(localStorage.getItem(cacheKey));
            if (cachedData) {
                console.log('Usando cache de mostReadPosts');
                return cachedData;
            }
        }*/
        const visitasRef = ref(db, 'posts');
        const snapshot = await get(visitasRef);

        if (!snapshot.exists()) {
            console.warn("No hay datos de visitas aún.");
            return [];
        }

        const visitasData = snapshot.val();

        // Convertir el objeto en array y ordenar por count desc
        const postsArray = Object.keys(visitasData).map(postId => {
            const postData = visitasData[postId];
            const slug = postData.slug || postId; // fallback robusto
            const titleKey = `title_${currentLang}`;

            return {
                id: postId,
                count: postData.views || 0,
                //title: postData.title || 'Sin título',
                title: postData[titleKey] || postData.title || 'Sin título',
                slug: slug,
                url: `/posts/${slug}/`,
            };
        }).filter(post => post.count > 0);

        postsArray.sort((a, b) => b.count - a.count);

        /*const topPosts = postsArray.slice(0, limit);

        // Cachea por 1 hora (3600000 ms)
        localStorage.setItem(cacheKey, JSON.stringify(topPosts));
        localStorage.setItem(cacheExpiryKey, (now + 3600000).toString());*/

        return postsArray.slice(0, limit);
    } catch (error) {
        console.error('Error obteniendo posts más leídos:', error);
        return [];
    }
}