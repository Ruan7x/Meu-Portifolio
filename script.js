// ======= Now Playing real (API do Spotify via servidor local) =======

const nowPlayingEl = document.getElementById('now-playing');
const profileLink = document.getElementById('spotify-profile-link');

const POLL_MS = 5000;
const TICK_MS = 1000;

let tickTimer = null;
let localProgressMs = 0;
let localDurationMs = 0;
let localSyncedAt = 0;

function formatClock(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function renderEmpty(icon, message) {
    nowPlayingEl.innerHTML = `
        <div class="np-empty">
            <div class="np-empty-icon">${icon}</div>
            <p>${message}</p>
        </div>
    `;
}

function renderTrack(data) {
    const track = data.track;
    const percent = data.durationMs > 0
        ? Math.min(100, (data.progressMs / data.durationMs) * 100)
        : 0;
    const statusClass = data.playing ? '' : 'paused';

    nowPlayingEl.innerHTML = `
        <div class="np-body">
            <div class="np-cover-wrap">
                <img src="${track.cover}" alt="${track.album}">
                <div class="np-cover-overlay">
                    <div class="np-cover-badge"></div>
                </div>
            </div>
            <div class="np-info">
                <div class="np-status">
                    <span class="np-dot ${statusClass}"></span>
                    <span class="np-status-text ${statusClass}">${data.playing ? 'Ouvindo agora' : 'Pausado'}</span>
                </div>
                <p class="np-title">${track.name}</p>
                <p class="np-artist">${track.artist}</p>
                <p class="np-album">${track.album}</p>
                <div class="np-progress-row">
                    <span id="np-progress">${formatClock(data.progressMs)}</span>
                    <div class="np-progress-track">
                        <div id="np-progress-fill" class="np-progress-fill" style="width: ${percent}%;"></div>
                    </div>
                    <span>${formatClock(data.durationMs)}</span>
                </div>
            </div>
        </div>
        <div class="np-footer">
            <span> 🟢 Spotify</span>
            <span>🔊 ${data.playing ? 'Tocando' : 'Pausado'}</span>
            ${track.spotifyUrl ? `<a class="np-track-link" href="${track.spotifyUrl}" target="_blank" rel="noopener noreferrer">Abrir faixa ↗</a>` : ''}
        </div>
    `;
}

function startLocalTicker() {
    clearInterval(tickTimer);

    tickTimer = setInterval(() => {
        const progressFill = document.getElementById('np-progress-fill');
        const progressLabel = document.getElementById('np-progress');
        if (!progressFill || !progressLabel || localDurationMs <= 0) return;

        const elapsedSinceSync = Date.now() - localSyncedAt;
        const estimatedMs = Math.min(localDurationMs, localProgressMs + elapsedSinceSync);
        const percent = Math.min(100, (estimatedMs / localDurationMs) * 100);

        progressFill.style.width = `${percent}%`;
        progressLabel.textContent = formatClock(estimatedMs);
    }, TICK_MS);
}

async function updateNowPlaying() {
    if (document.hidden) return;

    try {
        const response = await fetch('/api/current', { cache: 'no-store' });
        const data = await response.json();

        if (!response.ok || data.error) {
            // Mantém o último estado na tela em vez de mostrar erro para o visitante.
            return;
        }

        if (!data.connected) {
            clearInterval(tickTimer);
            renderEmpty('🎧', 'Ainda não conectei minha conta do Spotify aqui.');
            return;
        }

        if (!data.track) {
            clearInterval(tickTimer);
            renderEmpty('🎵', 'Nada tocando no Spotify agora.');
            return;
        }

        renderTrack(data);

        localProgressMs = data.progressMs;
        localDurationMs = data.durationMs;
        localSyncedAt = Date.now();

        if (data.playing) {
            startLocalTicker();
        } else {
            clearInterval(tickTimer);
        }
    } catch (error) {
        // Falha de rede: mantém o que já está na tela.
        console.error('Não foi possível atualizar o Spotify:', error);
    }
}

async function loadProfileLink() {
    if (!profileLink) return;

    try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        const data = await response.json();

        if (data.profileUrl) {
            profileLink.href = data.profileUrl;
        } else {
            profileLink.classList.add('disabled');
        }
    } catch {
        profileLink.classList.add('disabled');
    }
}

if (nowPlayingEl) {
    renderEmpty('🎧', 'Carregando...');
    updateNowPlaying();
    loadProfileLink();

    setInterval(updateNowPlaying, POLL_MS);
    document.addEventListener('visibilitychange', updateNowPlaying);
}
