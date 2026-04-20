FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    git \
    sqlite3 \
    nodejs \
    npm \
    fail2ban \
    ca-certificates \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --break-system-packages \
    fastapi \
    "uvicorn[standard]" \
    y-py \
    watchdog \
    python-frontmatter \
    pyyaml \
    argon2-cffi \
    Pillow \
    rembg[cpu] \
    python-multipart \
    httpx \
    psycopg2-binary

WORKDIR /workspace

CMD ["/workspace/start.sh"]
