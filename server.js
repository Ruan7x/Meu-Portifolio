import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
// Local: 127.0.0.1. Em hospedagem, defina HOST=0.0.0.0 nas variáveis de ambiente.
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const PROFILE_URL = process.env.SPOTIFY_PROFILE_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY;

const TOKEN_FILE = path.join(__dirname, ".spotify-token.json");
const SCOPES = "user-read-currently-playing";

// Todos os visitantes compartilham a mesma consulta ao Spotify por até 4 segundos.
const CACHE_MS = 4000;
// Se o Spotify falhar, ainda serve o último resultado por até 1 minuto.
const STALE_MS = 60_000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn("Configure SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET no arquivo .env");
}
if (!ADMIN_KEY) {
  console.warn("Configure ADMIN_KEY no .env. Sem ela, /login e /logout ficam bloqueados.");
}

let oauthState = null;
let tokenData = null;

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    }
  } catch {
    tokenData = null;
  }

  // Em hospedagens com disco temporário, o refresh token vem da variável de ambiente.
  if (process.env.SPOTIFY_REFRESH_TOKEN) {
    tokenData = { refresh_token: process.env.SPOTIFY_REFRESH_TOKEN };
  }
}

function saveToken() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
  } catch (error) {
    console.warn("Não foi possível salvar .spotify-token.json:", error.message);
  }
}

loadToken();

function randomString(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function base64url(buffer) {
  return buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

// Protege as rotas que mudam a conta conectada.
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).type("text").send("Defina ADMIN_KEY no .env para usar esta rota.");
  }

  const key = typeof req.query.key === "string" ? req.query.key : "";

  if (!safeEqual(key, ADMIN_KEY)) {
    return res.status(403).type("text").send("Acesso negado.");
  }

  next();
}

async function refreshAccessToken() {
  if (!tokenData?.refresh_token) {
    throw new Error("Spotify não está conectado. Acesse /login primeiro.");
  }

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenData.refresh_token
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Falha ao renovar token do Spotify.");
  }

  tokenData.access_token = data.access_token;
  tokenData.expires_at = Date.now() + (data.expires_in * 1000);

  if (data.refresh_token) {
    tokenData.refresh_token = data.refresh_token;
  }

  saveToken();
}

async function getAccessToken() {
  if (!tokenData?.access_token || Date.now() > (tokenData.expires_at - 60_000)) {
    await refreshAccessToken();
  }
  return tokenData.access_token;
}

async function spotifyFetch(url) {
  let accessToken = await getAccessToken();

  let response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  // Se o token expirou antes do cálculo acima, tenta uma vez novamente.
  if (response.status === 401) {
    await refreshAccessToken();
    accessToken = tokenData.access_token;

    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  }

  return response;
}

// ---------- Música atual (com cache compartilhado) ----------

let currentCache = { at: 0, status: 200, body: null };
let inflight = null;
let retryUntil = 0;

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function fetchCurrent() {
  if (!tokenData?.refresh_token) {
    return { status: 200, body: { connected: false, playing: false, track: null } };
  }

  const response = await spotifyFetch(
    "https://api.spotify.com/v1/me/player/currently-playing"
  );

  if (response.status === 204) {
    return { status: 200, body: { connected: true, playing: false, track: null } };
  }

  if (response.status === 429) {
    const wait = Number(response.headers.get("retry-after")) || 30;
    retryUntil = Date.now() + wait * 1000;
    return { status: 429, body: { error: "Spotify pediu um tempo de espera." } };
  }

  if (!response.ok) {
    console.error("Spotify API:", response.status, await response.text());
    return {
      status: response.status,
      body: { error: "Não foi possível consultar o Spotify agora." }
    };
  }

  const data = await response.json();

  if (!data?.item) {
    return { status: 200, body: { connected: true, playing: Boolean(data?.is_playing), track: null } };
  }

  const item = data.item;
  const artists = Array.isArray(item.artists)
    ? item.artists.map((artist) => artist.name).join(", ")
    : "";
  const progressMs = data.progress_ms ?? 0;
  const durationMs = item.duration_ms ?? 0;

  return {
    status: 200,
    body: {
      connected: true,
      playing: Boolean(data.is_playing),
      progressMs,
      durationMs,
      progress: formatClock(progressMs),
      duration: formatClock(durationMs),
      percent: durationMs > 0 ? Math.min(100, (progressMs / durationMs) * 100) : 0,
      serverTime: Date.now(),
      track: {
        id: item.id,
        name: item.name,
        artist: artists,
        album: item.album?.name ?? "",
        cover: item.album?.images?.[0]?.url ?? "",
        spotifyUrl: item.external_urls?.spotify ?? ""
      }
    }
  };
}

function staleOr(result) {
  const age = Date.now() - currentCache.at;
  return currentCache.body && age < STALE_MS ? currentCache : result;
}

async function getCurrent() {
  const now = Date.now();

  if (currentCache.body && now - currentCache.at < CACHE_MS) {
    return currentCache;
  }

  if (now < retryUntil) {
    return staleOr({ status: 429, body: { error: "Spotify pediu um tempo de espera." } });
  }

  if (!inflight) {
    inflight = fetchCurrent()
      .then((result) => {
        if (result.status === 200) {
          currentCache = { ...result, at: Date.now() };
        }
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const result = await inflight;
  return result.status === 200 ? result : staleOr(result);
}

// ---------- Rotas ----------

// Bloqueia o acesso direto aos arquivos do servidor; só o site em /public de fato é servido.
const BLOCKED_FILES = new Set([
  "server.js",
  "package.json",
  "package-lock.json",
  ".env",
  ".env.example",
  ".spotify-token.json",
  "README.md",
  "SETUP.txt"
]);
// Esta é uma página única (index.html na raiz), então só o essencial fica bloqueado.

app.use((req, res, next) => {
  const first = req.path.replace(/^\/+/, "").split("/")[0];
  if (BLOCKED_FILES.has(first) || first === "node_modules") {
    return res.status(404).end();
  }
  next();
});

app.use(express.static(__dirname, { dotfiles: "ignore" }));

app.get("/login", requireAdmin, (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).type("text").send("Configure o arquivo .env antes de conectar o Spotify.");
  }

  const verifier = randomString(48);
  const challenge = base64url(sha256(verifier));

  oauthState = {
    value: randomString(24),
    verifier,
    expiresAt: Date.now() + 10 * 60 * 1000
  };

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: oauthState.value,
    code_challenge_method: "S256",
    code_challenge: challenge
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).type("text").send(`Spotify recusou a autorização: ${String(error)}`);
  }

  if (
    !oauthState ||
    oauthState.expiresAt < Date.now() ||
    state !== oauthState.value
  ) {
    return res.status(400).type("text").send("Estado OAuth inválido ou expirado. Tente /login novamente.");
  }

  try {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: oauthState.verifier
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error_description || data.error || "Falha no token.");
    }

    tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in * 1000)
    };

    saveToken();
    oauthState = null;
    currentCache = { at: 0, status: 200, body: null };

    res.redirect("/index.html?spotify=connected");
  } catch (error) {
    oauthState = null;
    console.error(error);
    res.status(500).type("text").send("Erro ao conectar ao Spotify. Veja o log do servidor.");
  }
});

app.get("/logout", requireAdmin, (req, res) => {
  tokenData = null;
  currentCache = { at: 0, status: 200, body: null };

  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.rmSync(TOKEN_FILE);
    }
  } catch {}

  res.redirect("/index.html");
});

app.get("/api/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    connected: Boolean(tokenData?.refresh_token),
    profileUrl: PROFILE_URL || null
  });
});

app.get("/api/current", async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const { status, body } = await getCurrent();
    res.status(status).json(body);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao consultar o Spotify." });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Portfólio rodando em http://${HOST}:${PORT}`);
  console.log(`Site: http://${HOST}:${PORT}/index.html`);
  console.log(`Callback Spotify: ${REDIRECT_URI}`);
});
