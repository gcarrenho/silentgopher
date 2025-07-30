import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

export async function setupComments() {
    // Configuración inicial
    const supabase = createClient(
        window.PUBLIC_SUPABASE_URL,
        window.PUBLIC_SUPABASE_KEY
    );


    //const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const postId = document.body.dataset.postId;
    let currentUser = null;

    // Elementos del DOM
    const DOM = {
        commentCount: document.getElementById('comment-count'),
        commentCountSection: document.getElementById('comment-count-section'),
        replyToInput: document.getElementById('reply-to'),
        commentBtn: document.getElementById('comment-btn'),
        articleForm: document.querySelector('.comment-form'),



        createSidebar: () => {
            const sidebar = document.createElement('aside');
            sidebar.id = 'comment-sidebar';
            sidebar.innerHTML = `
                <div id="comments-container" class="comments-container"></div>
                 <div id="login-container" class="login-container" style="display: none;">
        <button id="login-github-btn" class="login-github-btn">
            Iniciar sesión con GitHub
        </button>
    </div>
                <form id="comment-form" class="comment-form">
                    <div class="comment-input-row">
                        <img id="user-avatar-img" src="https://www.gravatar.com/avatar/?d=mp&s=40" class="avatar-img">
                        <textarea id="comment-input" placeholder="Escribe tu comentario..." rows="2" required></textarea>
                    </div>
                    <div class="comment-form-actions">
                        <button type="submit" class="comment-submit-btn">Publicar</button>
                        <button type="button" id="close-sidebar" class="comment-cancel-btn">Cerrar</button>
                    </div>
                </form>`;
            document.body.appendChild(sidebar);
            return sidebar;
        }
    };

    // Inicialización
    const commentSidebar = DOM.createSidebar();
    const commentsContainer = commentSidebar.querySelector('#comments-container');

    // Funciones de utilidad
    const utils = {
        escapeHTML: (str) => str ? str.replace(/[&<>"'`=\/]/g, s => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
            "'": '&#39;', '`': '&#x60;', '=': '&#x3D;', '/': '&#x2F;'
        })[s]) : '',

        formatDate: (date) => new Intl.DateTimeFormat('en-GB', {
            day: '2-digit', month: 'short', year: '2-digit'
        }).format(new Date(date)),

        setButtonState: (button, { text, disabled = false, loading = false }) => {
            button.textContent = text;
            button.disabled = disabled;
            button.setAttribute('aria-busy', loading);
        }
    };

    // Gestión de usuarios
    /*const user = {
        check: async () => {
            const { data: { session } } = await supabase.auth.getSession();
            currentUser = session?.user || null;

            const loginContainer = document.getElementById('login-container');
            const commentForm = commentSidebar.querySelector('#comment-form');

            if (!currentUser) {
                loginContainer.style.display = 'flex';
                commentForm.style.display = 'none';
            } else {
                loginContainer.style.display = 'none';
                commentForm.style.display = 'block';
            }

            document.querySelectorAll('#user-avatar-img').forEach(img => {
                img.src = currentUser?.user_metadata?.avatar_url || 'https://www.gravatar.com/avatar/?d=mp&s=40';
            });
        },

        isAuthor: (comment) => currentUser && (currentUser.id === comment.author_github_id)
    };*/
    const user = {
        check: async () => {
            const { data: { session } } = await supabase.auth.getSession();
            currentUser = session?.user || null;

            // Elementos del DOM
            const loginContainer = document.getElementById('login-container');
            const sidebarForm = commentSidebar.querySelector('#comment-form');
            const mainForm = document.getElementById('main-comment-form');
            const sidebarLogin = commentSidebar.querySelector('#login-container');

            if (!currentUser) {
                // Mostrar botones de login y ocultar formularios
                if (loginContainer) loginContainer.style.display = 'flex';
                if (sidebarLogin) sidebarLogin.style.display = 'flex';
                if (sidebarForm) sidebarForm.style.display = 'none';
                if (mainForm) mainForm.style.display = 'none';

                // Configurar botones de login
                const loginButtons = document.querySelectorAll('#login-github-btn, #login-github-sidebar-btn');
                loginButtons.forEach(btn => {
                    btn.onclick = () => {
                        supabase.auth.signInWithOAuth({
                            provider: 'github',
                            options: {
                                redirectTo: window.location.href
                            }
                        });
                    };
                });
            } else {
                // Mostrar formularios y ocultar botones de login
                if (loginContainer) loginContainer.style.display = 'none';
                if (sidebarLogin) sidebarLogin.style.display = 'none';
                if (sidebarForm) sidebarForm.style.display = 'block';
                if (mainForm) mainForm.style.display = 'flex';

                // Actualizar avatares
                document.querySelectorAll('#user-avatar-img, #main-user-avatar-img').forEach(img => {
                    img.src = currentUser?.user_metadata?.avatar_url || 'https://www.gravatar.com/avatar/?d=mp&s=40';
                });
            }
        },
        /*check: async () => {
            const { data: { session } } = await supabase.auth.getSession();
            currentUser = session?.user || null;

            const loginContainer = document.getElementById('login-container');
            const commentForm = commentSidebar.querySelector('#comment-form');

            if (!currentUser) {
                loginContainer.style.display = 'flex';
                commentForm.style.display = 'none';

                // Configurar el botón de login
                const loginBtn = document.getElementById('login-github-btn');
                if (loginBtn) {
                    loginBtn.onclick = () => {
                        supabase.auth.signInWithOAuth({
                            provider: 'github',
                            options: {
                                redirectTo: window.location.href
                            }
                        });
                    };
                }
            } else {
                loginContainer.style.display = 'none';
                commentForm.style.display = 'block';

                // Actualizar avatar del usuario logueado
                document.querySelectorAll('#user-avatar-img').forEach(img => {
                    img.src = currentUser?.user_metadata?.avatar_url || 'https://www.gravatar.com/avatar/?d=mp&s=40';
                });
            }
        },*/

        isAuthor: (comment) => currentUser && (currentUser.id === comment.author_github_id)
    };

    // Operaciones con Supabase
    const db = {
        fetchComments: async () => {
            const { data, error } = await supabase
                .from('comments')
                .select('*')
                .eq('article_id', postId)
                .order('created_at', { ascending: true });
            return error ? (console.error(error), []) : data;
        },

        postComment: async (commentData) => {
            const { error } = await supabase.from('comments').insert([{
                article_id: postId,
                author_name: currentUser.user_metadata?.user_name || 'Anó',
                author_avatar: currentUser?.user_metadata?.avatar_url || null,
                author_github_id: currentUser?.id || null,
                ...commentData
            }]);
            return !error;
        },

        updateComment: async (commentId, content) => {
            const { error } = await supabase
                .from('comments')
                .update({ content })
                .eq('id', commentId);
            return !error;
        },

        deleteComment: async (commentId) => {
            const { error } = await supabase
                .from('comments')
                .delete()
                .eq('id', commentId);
            return !error;
        },


        handleReaction: async (commentId) => {
            if (!currentUser) {
                alert('Debes iniciar sesión para reaccionar');
                return false;
            }

            const { data: existingReaction, error: fetchError } = await supabase
                .from('comment_reactions')
                .select('id')
                .eq('comment_id', commentId)
                .eq('user_hash', currentUser.id)
                .eq('reaction_type', 'like')
                .maybeSingle();

            if (fetchError) {
                console.error('Error al buscar reacción:', fetchError);
                return false;
            }

            let isReacting;
            if (existingReaction) {
                const { error: deleteError } = await supabase
                    .from('comment_reactions')
                    .delete()
                    .eq('id', existingReaction.id);

                if (deleteError) {
                    console.error('Error al eliminar reacción:', deleteError);
                    return false;
                }
                isReacting = false;
            } else {
                const { error: insertError } = await supabase
                    .from('comment_reactions')
                    .insert([{
                        comment_id: commentId,
                        reaction_type: 'like',
                        user_hash: currentUser.id
                    }]);

                if (insertError) {
                    console.error('Error al insertar reacción:', insertError);
                    return false;
                }
                isReacting = true;
            }

            // Actualización optimista del contador
            const el = document.getElementById(`reaction-${commentId}`);
            const currentCount = parseInt(el.textContent) || 0;
            el.textContent = isReacting ? currentCount + 1 : currentCount - 1;

            // Obtener el conteo real de la base de datos
            const { count, error } = await supabase
                .from('comment_reactions')
                .select('id', { count: 'exact', head: true })
                .eq('comment_id', commentId)
                .eq('reaction_type', 'like');

            if (error) {
                console.error('Supabase error:', error);
            }

            // Sincronizar con el conteo real
            if (count !== null) {
                el.textContent = count;
            }

            return isReacting;
        }

    };

    // Componentes UI
    const components = {
        createCommentElement: (comment, level = 0) => {
            const card = document.createElement('div');
            card.className = 'comment-card';
            card.dataset.commentId = comment.id;
            const hasReacted = !!(currentUser && comment.reactions?.some(r => r.user_hash === currentUser.id));

            card.innerHTML = `
                <div class="comment-header">
                    <span>${comment.author_name || 'anon'}@${comment.article_id || 'post'}:~$</span>
                    <div class="comment-avatar-time">
                        <span class="comment-date">${utils.formatDate(comment.created_at)}</span>
                        <img src="${comment.author_avatar || 'https://www.gravatar.com/avatar/?d=mp&s=40'}" 
                             alt="${comment.author_name} avatar" class="avatar">
                    </div>
                </div>
                <div class="comment-text" id="comment-content-${comment.id}">
                    ${utils.escapeHTML(comment.content)}
                </div>
                <div class="comment-footer">
                    <button class="react-btn ${hasReacted ? 'reacted' : ''}" data-id="${comment.id}">
                👏 <span id="reaction-${comment.id}">${comment.reaction_count || 0}</span>
            </button>
                    <button class="reply-btn" data-id="${comment.id}">Responder</button>
                    ${user.isAuthor(comment) ? `
                        <button class="edit-btn" data-id="${comment.id}">Editar</button>
                        <button class="delete-btn" data-id="${comment.id}">Eliminar</button>
                    ` : ''}
                </div>
                <div class="reply-form-container" id="reply-form-${comment.id}"></div>
                <div class="edit-form-container" id="edit-form-${comment.id}"></div>
            `;

            if (comment.children?.length) {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'comment-children';
                comment.children.forEach(child => {
                    childrenContainer.appendChild(components.createCommentElement(child, level + 1));
                });
                card.appendChild(childrenContainer);
            }

            return card;
        },

        createForm: (type, commentId, content = '') => {
            const form = document.createElement('form');
            form.className = `${type}-form`;
            form.dataset[type === 'reply' ? 'replyTo' : 'commentId'] = commentId;

            form.innerHTML = `
                <div class="comment-input-row">
                    <img src="${currentUser?.user_metadata?.avatar_url || 'https://www.gravatar.com/avatar/?d=mp&s=40'}" 
                         class="avatar-img">
                    <textarea placeholder="Escribe tu ${type === 'reply' ? 'respuesta' : 'comentario'}..." 
                              rows="3" required>${utils.escapeHTML(content)}</textarea>
                </div>
                <div class="comment-form-actions">
                    <button type="submit" class="comment-submit-btn">
                        ${type === 'reply' ? 'Responder' : 'Guardar'}
                    </button>
                    <button type="button" class="comment-cancel-btn cancel-${type}">
                        Cancelar
                    </button>
                </div>
            `;

            return form;
        }
    };

    // Controladores de eventos
    const handlers = {
        reply: async (commentId, button) => {
            if (!currentUser) {
                alert('Por favor inicia sesión para responder');
                return;
            }
            document.querySelectorAll('.reply-form, .edit-form').forEach(f => f.remove());
            const container = document.getElementById(`reply-form-${commentId}`);

            const form = components.createForm('reply', commentId);
            container.appendChild(form);
            form.querySelector('textarea').focus();

            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const content = form.querySelector('textarea').value.trim();
                if (!content) return alert('La respuesta no puede estar vacía');

                if (await db.postComment({ content, parent_id: commentId })) {
                    loadComments();
                } else {
                    alert('Error al enviar la respuesta');
                }
            });

            form.querySelector('.cancel-reply').addEventListener('click', () => form.remove());
        },

        edit: async (commentId, button) => {
            document.querySelectorAll('.reply-form, .edit-form').forEach(f => f.remove());
            utils.setButtonState(button, { text: 'Cargando...', disabled: true, loading: true });

            try {
                const { data: comment, error } = await supabase
                    .from('comments')
                    .select('*')
                    .eq('id', commentId)
                    .single();

                if (error) throw error;

                document.getElementById(`comment-content-${commentId}`).style.display = 'none';
                button.style.display = 'none';

                const form = components.createForm('edit', commentId, comment.content);
                document.getElementById(`edit-form-${commentId}`).appendChild(form);

                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const content = form.querySelector('textarea').value.trim();
                    if (!content) return alert('El comentario no puede estar vacío');

                    if (await db.updateComment(commentId, content)) {
                        loadComments();
                    } else {
                        alert('Error al actualizar el comentario');
                    }
                });

                form.querySelector('.cancel-edit').addEventListener('click', () => {
                    form.remove();
                    document.getElementById(`comment-content-${commentId}`).style.display = '';
                    button.style.display = '';
                    utils.setButtonState(button, { text: 'Editar' });
                });

            } catch (error) {
                console.error('Error al editar:', error);
                utils.setButtonState(button, { text: 'Editar' });
                alert('Error al cargar el comentario para editar');
            }
        },

        delete: async (commentId, button) => {
            if (!confirm('¿Estás seguro de que quieres eliminar este comentario?')) return;

            utils.setButtonState(button, { text: 'Eliminando...', disabled: true, loading: true });

            if (await db.deleteComment(commentId)) {
                loadComments();
            } else {
                alert('Error al eliminar el comentario');
                utils.setButtonState(button, { text: 'Eliminar' });
            }
        },

        reaction: async (commentId) => {
            if (!currentUser) {
                alert('Por favor inicia sesión para responder');
                return;
            }
            const button = document.querySelector(`.react-btn[data-id="${commentId}"]`);
            if (button.dataset.processing === 'true') return;

            button.dataset.processing = 'true';
            try {
                if (!currentUser) {
                    alert('Por favor inicia sesión para reaccionar a comentarios');
                    return;
                }

                const isReacting = await db.handleReaction(commentId);
                button.classList.toggle('reacted', isReacting);
            } catch (error) {
                console.error('Error en reacción:', error);
            } finally {
                button.dataset.processing = 'false';
            }
        },

        commentSubmit: async (form, e) => {
            if (!currentUser) {
                alert('Por favor inicia sesión para responder');
                return;
            }
            e.preventDefault();
            const content = form.querySelector('textarea').value.trim();
            if (!content) return;

            if (await db.postComment({ content, parent_id: DOM.replyToInput.value || null })) {
                form.querySelector('textarea').value = '';
                DOM.replyToInput.value = '';
                loadComments();
            } else {
                alert('Error al enviar el comentario.');
            }
        }
    };

    // Carga de datos
    const loaders = {
        comments: async () => {
            const comments = await db.fetchComments();
            const buildTree = (comments) => {
                const map = {}, roots = [];
                comments.forEach(c => (map[c.id] = { ...c, children: [] }));
                comments.forEach(c => (c.parent_id ? map[c.parent_id]?.children.push(map[c.id]) : roots.push(map[c.id])));
                return roots;
            };

            commentsContainer.innerHTML = comments.length ? '' : `
                <div class="comment-placeholder">
                    <p>No hay comentarios aún. Sé el primero en comentar.</p>
                </div>`;

            buildTree(comments).forEach(comment => {
                commentsContainer.appendChild(components.createCommentElement(comment));
            });

            DOM.commentCount.textContent = comments.length;
            DOM.commentCountSection.textContent = comments.length;
        },

        reactions: async () => {
            const { data: counts } = await supabase.from('comment_reactions_count').select('*');
            const { data: userReactions } = currentUser ? await supabase
                .from('comment_reactions')
                .select('comment_id')
                .eq('user_hash', currentUser.id)
                .eq('reaction_type', 'like') : { data: [] };

            counts?.forEach(r => {
                const el = document.getElementById(`reaction-${r.comment_id}`);
                if (el) {
                    el.textContent = r.reaction_count ?? 0;

                    // Marcar botones donde el usuario ha reaccionado
                    const button = el.closest('.react-btn');
                    if (button) {
                        const hasReacted = userReactions.some(ur => ur.comment_id === r.comment_id);
                        button.classList.toggle('reacted', hasReacted);
                    }
                }
            });
        }
    };

    // Inicialización de eventos
    const initEvents = () => {
        // Delegación de eventos principal
        commentsContainer.addEventListener('click', async (e) => {
            if (!e.target.dataset?.id) return;
            e.stopPropagation();

            const { id } = e.target.dataset;
            if (e.target.classList.contains('reply-btn')) return handlers.reply(id, e.target);
            if (e.target.classList.contains('edit-btn')) return handlers.edit(id, e.target);
            if (e.target.classList.contains('delete-btn')) return handlers.delete(id, e.target);
            if (e.target.classList.contains('react-btn')) return handlers.reaction(id);
            if (e.target.classList.contains('cancel-reply')) return e.target.closest('.reply-form')?.remove();
            if (e.target.classList.contains('cancel-edit')) {
                const form = e.target.closest('.edit-form');
                document.getElementById(`comment-content-${form.dataset.commentId}`).style.display = '';
                document.querySelector(`.edit-btn[data-id="${form.dataset.commentId}"]`).style.display = '';
                form.remove();
            }
        });

        // Eventos del sidebar
        document.getElementById('close-sidebar').onclick = () => commentSidebar.classList.remove('open');

        //DOM.commentBtn.onclick = () => commentSidebar.classList.add('open');
        DOM.commentBtn.onclick = () => {
            commentSidebar.classList.add('open');

            // Esperar al próximo frame para asegurar que el sidebar se muestra antes del focus/scroll
            requestAnimationFrame(() => {
                const textarea = commentSidebar.querySelector('#comment-input');
                if (textarea) {
                    textarea.focus();

                    // Opcional: colocar el cursor al final si ya hay texto
                    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

                    // Hacer scroll para que quede visible aunque haya muchos comentarios
                    textarea.scrollIntoView({ behavior: 'smooth', block: 'end' });
                }
            });
        };

        // Formularios principales
        if (DOM.articleForm) DOM.articleForm.addEventListener('submit', (e) => handlers.commentSubmit(DOM.articleForm, e));
        if (commentSidebar.querySelector('#comment-form')) {
            commentSidebar.querySelector('#comment-form')
                .addEventListener('submit', (e) => handlers.commentSubmit(commentSidebar.querySelector('#comment-form'), e));
        }
    };

    // Inicialización de la aplicación
    const init = async () => {
        await user.check();
        await loaders.comments();
        await loaders.reactions();
        initEvents();

        // Escuchar cambios de autenticación
        supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN') {
                currentUser = session.user;
                user.check();
                loaders.comments();
                loaders.reactions();
            } else if (event === 'SIGNED_OUT') {
                currentUser = null;
                user.check();
            }
        });
    };

    // Alias para funciones principales
    const loadComments = loaders.comments;
    //const loadReactions = loaders.reactions;

    // Iniciar la aplicación
    init();
}