# Backend `pi` — REMOVIDO (registro historico)

> **Este backend nao existe mais.** O commit `2ce2bc6` removeu
> `src/orchestrator/backends/pi/` e o pacote `@mariozechner/pi-coding-agent`
> junto com ele. Hoje `src/orchestrator/backends/registry.ts:18` declara
> `type AgentBackendKind = 'jcode' | 'stub'` — nao ha `pi`, nao ha `azure`.
>
> Este arquivo permanece apenas como **marcador**, porque varios documentos
> vivos ainda apontam para ele. O conteudo original (modelo mental, spawn da
> sessao, traducao de eventos, thinking level, deteccao de termino) continua
> no historico: `git log --follow -p -- docs/pi-coding-agent.md`.

## Para onde ir agora

| Se voce procurava…                                   | Leia                                         |
|------------------------------------------------------|----------------------------------------------|
| Instalar e configurar o backend real (`jcode`)        | [`jcode-setup-guide.md`](jcode-setup-guide.md) |
| A arquitetura de backends e o dispatch por `kind`     | [`ARCHITECTURE.md`](ARCHITECTURE.md) · `src/orchestrator/backends/registry.ts` |
| Como escrever prompts de step para o agente           | [`prompting-playbook.md`](prompting-playbook.md) |
| Isolamento de portas por agente (`.env.huu`, shim)    | [`PORT-SHIM.md`](PORT-SHIM.md)               |
| Como adicionar/depurar um backend                     | `.agents/skills/integrating-llm-backends/SKILL.md` |

## O que mudou de fato entre `pi` e `jcode`

Duas diferencas estruturais valem ser lembradas, porque quase toda pagina do
documento antigo dependia delas:

- **`pi` rodava IN-PROCESS** (uma sessao do SDK dentro do heap do proprio huu);
  **`jcode` e um SUBPROCESSO CLI** — `jcode run --no-update --provider-profile
  <perfil> --model <id> -- <prompt>` (`backends/jcode/factory.ts`,
  `buildJcodeArgs`). O prompt viaja em **argv**, nao em stdin, e por isso existe
  um teto de tamanho por argumento que o backend antigo nao tinha.
- **A configuracao do provider era do SDK; agora e um arquivo TOML** que o huu
  escreve sozinho em `~/.huu/jcode-home/config.toml`
  (`backends/jcode/hermetic.ts`) e aponta `JCODE_HOME` para ele. O arquivo
  **nunca** carrega segredo: ele so nomeia a variavel (`api_key_env`), e o valor
  entra no env do spawn pela cadeia de `src/lib/api-key.ts`.
