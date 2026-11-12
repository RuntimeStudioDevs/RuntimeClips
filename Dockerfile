FROM node:22-bullseye-slim

# Instalar FFmpeg, Chromium, curl, python3 y dependencias de sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    python3 \
    curl \
    ca-certificates \
    git \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Instalar yt-dlp binario oficial
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Instalar Deno (usado por yt-dlp para resolver firmas y bloqueos de bot)
RUN curl -fsSL https://deno.land/install.sh | sh \
    && cp /root/.deno/bin/deno /usr/local/bin/deno \
    && chmod a+rx /usr/local/bin/deno

# Configurar variables de entorno para headless Chrome y Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Copiar manifiestos e instalar dependencias
COPY package*.json ./
RUN npm ci --omit=dev || npm install

# Copiar el código fuente completo
COPY . .

# Ejecutar setup para descargar modelos locales (UltraFace, Parakeet)
RUN npm run setup || true

EXPOSE 3000

CMD ["npm", "start"]
