#!/usr/bin/env bash
# scripts/smoke-image.sh — smoke estrutural da imagem huu.
# Substitui o que era o job smoke-test em .github/workflows/docker.yml.
#
# Uso:  ./scripts/smoke-image.sh                    # contra huu:local
#       ./scripts/smoke-image.sh huu:0.3.0          # contra tag específica
#       HUU_SMOKE_IMAGE=ghcr.io/.../huu:latest \
#           ./scripts/smoke-image.sh
#
# Opcional — exercitar o OUTRO lado do build arg INCLUDE_SURF na mesma rodada:
#       docker build --build-arg INCLUDE_SURF=false -t huu:local-nosurf .
#       HUU_SMOKE_IMAGE_NOSURF=huu:local-nosurf ./scripts/smoke-image.sh
#   (sem essa var o script exercita os dois lados MESMO ASSIM — ver §surf
#    abaixo: a ausência é simulada com um PATH sem o bin, dentro da imagem.)
#
# Sai 0 em sucesso, !=0 em falha. Encadeável em && com smoke-pipeline.sh.

set -euo pipefail

IMAGE="${1:-${HUU_SMOKE_IMAGE:-huu:local}}"
IMAGE_NOSURF="${HUU_SMOKE_IMAGE_NOSURF:-}"

step() { printf '\n[smoke-image] %s\n' "$*"; }
fail() { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }

step "imagem: $IMAGE"
docker image inspect "$IMAGE" >/dev/null \
    || fail "imagem $IMAGE não existe local. Rode 'docker build -t huu:local .' primeiro."

step "huu --help"
docker run --rm "$IMAGE" huu --help >/dev/null \
    || fail "huu --help retornou erro"

step "tini é PID 1"
PID1=$(docker run --rm "$IMAGE" sh -c 'cat /proc/1/comm')
test "$PID1" = "tini" \
    || fail "PID 1 é '$PID1', esperado 'tini'"

step "git presente"
docker run --rm --entrypoint sh "$IMAGE" -c 'git --version' >/dev/null \
    || fail "git ausente da imagem"

step "safe.directory wildcard configurada"
docker run --rm --entrypoint sh "$IMAGE" -c \
    'git config --system --get-all safe.directory' \
    | grep -qF '*' \
    || fail "safe.directory '*' ausente"

step "bind-mount worktree consistency (gotcha §4.1)"
# O repo scratch precisa viver num caminho que a VM do Docker bind-monta.
# No macOS o mktemp padrão cai em /var/folders/… — fora do file sharing do
# Docker Desktop/colima (o mount chega vazio) — e o mktemp do Darwin ignora
# TMPDIR, daí o template explícito. Default no macOS: dentro do próprio repo
# huu (se deu pra buildar a imagem daqui, este caminho está compartilhado
# com a VM). Override: HUU_SMOKE_TMPDIR.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(uname)" = Darwin ]; then SMOKE_TMP="${HUU_SMOKE_TMPDIR:-$SCRIPT_DIR/../.smoke-tmp}"; else SMOKE_TMP="${HUU_SMOKE_TMPDIR:-${TMPDIR:-/tmp}}"; fi
mkdir -p "$SMOKE_TMP"
# Normaliza (sem "..") — o caminho vira alvo de -v/-w no container, onde os
# diretórios intermediários do caminho não normalizado não existem.
SMOKE_TMP="$(cd "$SMOKE_TMP" && pwd)"
REPO=$(mktemp -d "$SMOKE_TMP/repo.XXXXXX")
trap "rm -rf $REPO" EXIT
git init -q "$REPO"
git -C "$REPO" config user.email smoke@huu.test
git -C "$REPO" config user.name smoke
echo "smoke" > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -q -m init

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$REPO:$REPO" -w "$REPO" \
    --entrypoint sh "$IMAGE" -c "git worktree add '$REPO/wt' HEAD"

git -C "$REPO" worktree list | grep -qF "$REPO/wt" \
    || fail "host's git not seeing the worktree at expected path"

git -C "$REPO" worktree remove --force "$REPO/wt"

step "HEALTHCHECK probe é idle-safe"
docker run --rm --entrypoint sh "$IMAGE" -c '
    if [ -f /tmp/huu/active ]; then
        cd "$(cat /tmp/huu/active)" && exec huu status --liveness
    else
        exit 0
    fi
' || fail "HEALTHCHECK probe retornou !=0 numa imagem ociosa"

# ──────────── surf: a CLI de pesquisa web (build arg INCLUDE_SURF) ────────────
#
# `surf-research-skill` é uma capacidade OPCIONAL da imagem (INCLUDE_SURF,
# default true). Duas propriedades, e as DUAS são exercitadas aqui:
#
#   1. presente ⇒ ela RESPONDE (`--version` sai 0) e o `keys.json` que o
#      `ensureSurfKeys()` do huu materializa é legível PELA PRÓPRIA surf
#      (`keys list` — leitura local, sem rede);
#   2. ausente ⇒ NADA quebra. `probeSurf()` devolve `research:false` + `reason`
#      em vez de lançar; `ensureSurfKeys()` sem nenhuma chave devolve
#      `written:false` + `reason` e não cria arquivo nenhum; e o CLI do huu roda
#      normalmente com o bin fora do PATH.
#
# (2) é o ponto do bloco inteiro: CLI ou chave faltando JAMAIS pode falhar um
# run. Ela é testada MESMO numa imagem com INCLUDE_SURF=true — o lado ausente é
# reproduzido chamando `probeSurf()` com um PATH vazio, que é exatamente o
# ENOENT que uma imagem slim entrega. Para checar também que o build arg de
# fato não instala nada quando é false, passe HUU_SMOKE_IMAGE_NOSURF=<tag>.
#
# O que este bloco NÃO prova: que uma pesquisa web real funciona. Nenhuma
# chamada de rede é feita, a chave usada é um literal falso, e o container é
# efêmero com HOME isolado — nada toca o estado do host.

# JS avulso: probeSurf() nos dois sentidos, dentro da imagem, contra o dist real.
# HUU_SMOKE_EXPECT_SURF=1 quando o bin existe na imagem, 0 quando não.
SURF_PROBE_JS='
import("/opt/huu/dist/lib/surf-research.js").then((m) => {
  const want = process.env.HUU_SMOKE_EXPECT_SURF === "1";
  const present = m.probeSurf();
  m.resetSurfProbeCache();
  const absent = m.probeSurf({ PATH: "/nonexistent-huu-smoke" });
  if (present.research !== want) {
    console.error("probeSurf().research=" + present.research + ", esperado " + want +
                  " (" + (present.reason || "sem reason") + ")");
    process.exit(1);
  }
  if (absent.research || !absent.reason) {
    console.error("probeSurf com PATH vazio devia dar research:false + reason, deu " +
                  JSON.stringify(absent));
    process.exit(1);
  }
  console.log("    probeSurf(PATH normal) = " + JSON.stringify(present));
  console.log("    probeSurf(PATH vazio)  = " + JSON.stringify(absent));
}).catch((e) => { console.error("probeSurf LANCOU: " + e); process.exit(1); });
'

# JS avulso: ensureSurfKeys() sem NENHUMA chave configurada. Tem de degradar em
# silêncio — devolver o motivo, não escrever nada, nunca lançar.
SURF_NOKEY_JS='
import("/opt/huu/dist/lib/surf-research.js").then(async (m) => {
  const fs = await import("node:fs");
  const r = m.ensureSurfKeys();
  if (r.written) {
    console.error("ensureSurfKeys escreveu sem chave nenhuma: " + JSON.stringify(r));
    process.exit(1);
  }
  if (!r.reason) {
    console.error("ensureSurfKeys degradou sem reason: " + JSON.stringify(r));
    process.exit(1);
  }
  if (fs.existsSync(r.path)) {
    console.error("ensureSurfKeys criou " + r.path + " sem chave nenhuma");
    process.exit(1);
  }
  console.log("    ensureSurfKeys(sem chave) = " + JSON.stringify(r));
}).catch((e) => { console.error("ensureSurfKeys LANCOU: " + e); process.exit(1); });
'

# Shell avulso: materializa o keys.json a partir de uma chave FALSA e faz a
# própria surf lê-lo de volta. `keys list` é local — não fala com provider nenhum.
SURF_KEYED_SH=$(cat <<'INNER'
set -e
node -e '
import("/opt/huu/dist/lib/surf-research.js").then(async (m) => {
  const fs = await import("node:fs");
  const r = m.ensureSurfKeys();
  if (!r.written) {
    console.error("ensureSurfKeys nao escreveu com TAVILY_API_KEY setada: " + JSON.stringify(r));
    process.exit(1);
  }
  const mode = (fs.statSync(r.path).mode & 511).toString(8);
  if (mode !== "600") { console.error("keys.json com modo " + mode + ", esperado 600"); process.exit(1); }
  const f = JSON.parse(fs.readFileSync(r.path, "utf8"));
  if (!f.tavily || f.tavily.keys[0] !== process.env.TAVILY_API_KEY) {
    console.error("a chave nao chegou ao keys.json: " + JSON.stringify(f.tavily));
    process.exit(1);
  }
  console.log("    ensureSurfKeys(com chave) = " + JSON.stringify(r) + ", modo " + mode);
}).catch((e) => { console.error("ensureSurfKeys LANCOU: " + e); process.exit(1); });
'
surf-research-skill keys list | sed 's/^/    /'
INNER
)

# surf_checks <imagem> <present|absent|auto>
surf_checks() {
    local img="$1"
    local expect="$2"
    local bin ver want b

    bin=$(docker run --rm --entrypoint sh "$img" -c 'command -v surf-research-skill || true')

    if [ -n "$bin" ]; then
        if [ "$expect" = absent ]; then
            fail "surf-research-skill presente em $img — INCLUDE_SURF=false instalou a CLI mesmo assim"
        fi
        ver=$(docker run --rm --entrypoint sh "$img" -c 'surf-research-skill --version') \
            || fail "surf-research-skill existe em $img mas '--version' retornou !=0"
        if [ -z "$ver" ]; then
            fail "surf-research-skill --version não imprimiu nada em $img"
        fi
        echo "    surf-research-skill $ver ($bin)"
        # Os binários que os prompts de pesquisa chamam PRIMEIRO. Não são
        # extras: `surf-search-normal` é a Camada A inteira (a onda autônoma
        # que devolve resposta já citada) e `surf-search-unlimit` é a versão
        # sem teto de ondas. Uma imagem sem eles instalou o pacote errado —
        # foi exatamente esse o bug: o Dockerfile pedia `surf-skill`, o nome
        # ABANDONADO no npm ("Renomeado para surf-agent-skill"), enquanto o
        # código chamava a v8 do `surf-agent-skill`.
        for b in surf-search-normal surf-search-unlimit; do
            docker run --rm --entrypoint sh "$img" -c "command -v $b" >/dev/null 2>&1 \
                || fail "$b ausente de $img — a imagem instalou o pacote de surf errado (esperado surf-agent-skill@8)"
        done
        echo "    surf-search-normal + surf-search-unlimit: presentes (Camada A completa)"

        # `surf-free-skill` tem de estar AUSENTE, e por DESIGN, não por acaso
        # de versão: a v8 não tem degrau sem chave — Brave é o único backend e
        # sem chave o comando sai 78 antes de rodar qualquer coisa. Se ele
        # aparecer, a imagem instalou um pacote PRÉ-v8 (surf-skill 5.2+/7.x),
        # e a escada de duas camadas que os prompts descrevem está mentindo.
        if docker run --rm --entrypoint sh "$img" -c 'command -v surf-free-skill' >/dev/null 2>&1; then
            fail "surf-free-skill presente em $img — a v8 não tem degrau sem chave; a imagem está numa surf pré-v8"
        fi
        echo "    surf-free-skill: ausente (correto — a v8 não tem camada sem chave)"
        want=1
    else
        if [ "$expect" = present ]; then
            fail "surf-research-skill ausente de $img, que deveria ter sido construída com INCLUDE_SURF=true"
        fi
        echo "    surf-research-skill ausente — imagem sem INCLUDE_SURF; só o lado da degradação se aplica"
        want=0
    fi

    # Defaults do Dockerfile, setados FORA do `if INCLUDE_SURF` — valem nas duas
    # imagens. SURF_QUIET mantém o ruído de progresso da CLI fora do transcript
    # do agente; SURF_AGENT_BUDGET_MS limita uma pesquisa a 4 min pra um
    # provider travado não comer o timeout do card.
    docker run --rm --entrypoint sh "$img" -c \
        'test "$SURF_QUIET" = 1 && test "$SURF_AGENT_BUDGET_MS" = 240000' \
        || fail "defaults SURF_QUIET=1 / SURF_AGENT_BUDGET_MS=240000 ausentes de $img"

    docker run --rm \
        -e "HUU_SMOKE_EXPECT_SURF=$want" \
        --entrypoint node "$img" -e "$SURF_PROBE_JS" \
        || fail "probeSurf() não se comportou como o esperado em $img"

    docker run --rm \
        -e HOME=/tmp/surf-smoke-empty \
        -e HUU_CONFIG_DIR=/tmp/surf-smoke-empty/cfg \
        --entrypoint node "$img" -e "$SURF_NOKEY_JS" \
        || fail "ensureSurfKeys() sem chave não degradou em silêncio em $img"

    if [ -n "$bin" ]; then
        docker run --rm \
            -e HOME=/tmp/surf-smoke-home \
            -e HUU_CONFIG_DIR=/tmp/surf-smoke-home/cfg \
            -e TAVILY_API_KEY=tvly-smoke-not-a-real-key \
            --entrypoint sh "$img" -c "$SURF_KEYED_SH" \
            || fail "o keys.json escrito pelo huu não foi lido de volta pela surf em $img"
    fi

    # O CLI do huu não pode DEPENDER da surf: com o bin fora do PATH ele roda
    # igual. (Invocação por caminho absoluto justamente porque o PATH restrito
    # também esconderia o próprio `huu`.)
    docker run --rm \
        -e PATH=/usr/bin:/bin \
        --entrypoint /usr/local/bin/node "$img" /opt/huu/dist/cli.js --help >/dev/null \
        || fail "huu --help falhou com a CLI da surf fora do PATH em $img"
}

step "surf: CLI, chaves e o caminho de degradação"
surf_checks "$IMAGE" auto

if [ -n "$IMAGE_NOSURF" ]; then
    step "surf: o outro lado do build arg ($IMAGE_NOSURF)"
    docker image inspect "$IMAGE_NOSURF" >/dev/null \
        || fail "imagem $IMAGE_NOSURF não existe local (docker build --build-arg INCLUDE_SURF=false -t $IMAGE_NOSURF .)"
    surf_checks "$IMAGE_NOSURF" absent
fi

step "tamanho da imagem"
docker images "$IMAGE" --format '  size = {{.Size}}'

printf '\n[smoke-image] OK\n'
