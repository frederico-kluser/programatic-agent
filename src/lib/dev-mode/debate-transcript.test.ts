import { describe, expect, it } from 'vitest';
import {
  MAX_BRIEF_CHARS,
  MAX_DECISIONS,
  MAX_FIELD_CHARS,
  MAX_LINE_CHARS,
  MAX_TITLE_CHARS,
  MAX_VERDICTS,
  DEBATE_ADVOCATE_STEP_NAME,
  DEBATE_GATE_STEP_NAME,
  DEBATE_PROSECUTOR_STEP_NAME,
  buildDebateTranscript,
  debateRoleOfStep,
  findDebateSteps,
  hasDebate,
  parseDebateBriefA,
  parseDebateBriefB,
} from './debate-transcript.js';
import { compileEpochPipeline } from './plan-to-pipeline.js';
import type { CheckOutcome, DevFront, DevPlan, Pipeline } from '../types.js';

// ─────────────────────────── fixtures ───────────────────────────────────────

const WELL_FORMED_A = `## Decisões
### D1 — Dividir a época em duas frentes
- **Escolhido:** duas frentes, api e cli
- **Rejeitado:** uma frente única cobrindo os dois módulos
- **Por quê:** o atlas em .huu/dev/epoch-1/atlas.md separa api de cli
- **Falsificaria:** as duas frentes tocarem o mesmo arquivo no merge

### D2 — Manter o schema atual
- **Escolhido:** estender o schema existente
- **Rejeitado:** criar um schema paralelo v2
- **Por quê:** src/lib/types/pipeline.ts já carrega o contrato
- **Falsificaria:** um campo novo que não caiba sem quebrar o parse

## Riscos assumidos
- A frente cli depende do merge da api; se atrasar, a época fecha sem cli.
- O atlas pode estar desatualizado em relação ao HEAD.
`;

const WELL_FORMED_B = `## Veredito por decisão
- D1: SUSTENTADA — a separação bate com o mapa de arquivos do atlas
- D2: CONTESTADA — estender o schema quebra o parse dos pipelines já salvos

## Objeções
### D2
- **Falha prevista:** PipelineSchema.safeParse falha em qualquer arquivo salvo antes da v2
- **Evidência:** src/lib/pipeline-io.ts, e registry.test.ts cobre o round-trip
- **Alternativa mais barata:** adicionar o campo como opcional e defaultar no parse
`;

// ─────────────────────────── brief A ────────────────────────────────────────

describe('parseDebateBriefA', () => {
  it('extracts every decision and every field from a well-formed record', () => {
    const a = parseDebateBriefA(WELL_FORMED_A);
    expect(a.side).toBe('A');
    expect(a.present).toBe(true);
    expect(a.parsed).toBe(true);
    expect(a.missingSections).toEqual([]);
    expect(a.decisions.map((d) => d.id)).toEqual(['D1', 'D2']);
    expect(a.decisions[0]).toMatchObject({
      id: 'D1',
      title: 'Dividir a época em duas frentes',
      escolhido: 'duas frentes, api e cli',
      rejeitado: 'uma frente única cobrindo os dois módulos',
      porQue: 'o atlas em .huu/dev/epoch-1/atlas.md separa api de cli',
      falsificaria: 'as duas frentes tocarem o mesmo arquivo no merge',
    });
    expect(a.decisions[1]?.escolhido).toBe('estender o schema existente');
    expect(a.risks.map((r) => r.text)).toEqual([
      'A frente cli depende do merge da api; se atrasar, a época fecha sem cli.',
      'O atlas pode estar desatualizado em relação ao HEAD.',
    ]);
    expect(a.sections).toEqual([
      { id: 'decisoes', found: true, entries: 2, expected: true },
      { id: 'riscos', found: true, entries: 2, expected: true },
    ]);
  });

  // O cru é o fallback de renderização E a prova para o usuário: ele sai
  // verbatim mesmo quando o parse foi perfeito.
  it('keeps the raw markdown byte for byte even on a perfect parse', () => {
    const a = parseDebateBriefA(WELL_FORMED_A);
    expect(a.raw).toBe(WELL_FORMED_A);
    expect(a.truncated).toBe(false);
    expect(a.decisions[0]?.raw.startsWith('### D1 — Dividir')).toBe(true);
    expect(a.decisions[0]?.raw).toContain('**Falsificaria:**');
    expect(a.decisions[0]?.raw).not.toContain('D2');
  });

  it('tolerates case, accents, marker placement and heading level', () => {
    const md = `# DECISÕES
##### D1 - primeira
- **Escolhido**: valor um
- Rejeitado : valor dois
- **POR QUÊ:** valor três
- **Falsificaria**: valor quatro

##Riscos Assumidos
- risco único
`;
    const a = parseDebateBriefA(md);
    expect(a.parsed).toBe(true);
    expect(a.decisions[0]).toMatchObject({
      id: 'D1',
      title: 'primeira',
      escolhido: 'valor um',
      rejeitado: 'valor dois',
      porQue: 'valor três',
      falsificaria: 'valor quatro',
    });
    expect(a.risks).toHaveLength(1);
  });

  it('accepts "Por que" without the circumflex and "Motivo" as a synonym', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- **Por que:** sem acento

### D2 — y
- **Motivo:** sinônimo

## Riscos assumidos
`);
    expect(a.decisions[0]?.porQue).toBe('sem acento');
    expect(a.decisions[1]?.porQue).toBe('sinônimo');
  });

  it('folds a wrapped value into the field instead of dropping it', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- **Escolhido:** primeira linha
  segunda linha
- **Rejeitado:** outra coisa

## Riscos assumidos
- r
`);
    expect(a.decisions[0]?.escolhido).toBe('primeira linha\nsegunda linha');
    expect(a.decisions[0]?.rejeitado).toBe('outra coisa');
  });

  // Um heading extra no meio do bloco não pode custar os campos que vêm
  // depois dele — o modelo intercala seções o tempo todo.
  it('survives an unknown heading inside a decision block', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- **Escolhido:** um
### Contexto adicional
- **Por quê:** dois

## Riscos assumidos
- r
`);
    expect(a.decisions).toHaveLength(1);
    expect(a.decisions[0]?.escolhido).toBe('um');
    expect(a.decisions[0]?.porQue).toBe('dois');
    expect(a.warnings.join(' ')).toMatch(/heading não reconhecido/);
  });

  it('does not care about bullet order or extra whitespace', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — fora de ordem
   - **Falsificaria:**    quatro
- **Por quê:**  três
     -   **Escolhido:**   um
- **Rejeitado:** dois

## Riscos assumidos
   -    risco com espaço
`);
    expect(a.parsed).toBe(true);
    expect(a.decisions[0]).toMatchObject({
      escolhido: 'um',
      rejeitado: 'dois',
      porQue: 'três',
      falsificaria: 'quatro',
    });
    expect(a.risks[0]?.text).toBe('risco com espaço');
  });

  it('keeps decisions in document order with non-sequential ids', () => {
    const a = parseDebateBriefA(`## Decisões
### D10 — dez
- **Escolhido:** dez
### D2 — dois
- **Escolhido:** dois
### d 7 — sete
- **Escolhido:** sete

## Riscos assumidos
- r
`);
    expect(a.decisions.map((d) => d.id)).toEqual(['D10', 'D2', 'D7']);
    expect(a.decisions.map((d) => d.escolhido)).toEqual(['dez', 'dois', 'sete']);
    expect(a.parsed).toBe(true);
  });

  it('warns when the same decision id is declared twice', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- **Escolhido:** um
### D1 — de novo
- **Escolhido:** dois

## Riscos assumidos
- r
`);
    expect(a.decisions).toHaveLength(2);
    expect(a.warnings.join(' ')).toMatch(/D1 declarada mais de uma vez/);
  });

  it('reads decisions even when the "## Decisões" heading is missing', () => {
    const a = parseDebateBriefA(`### D1 — sem seção
- **Escolhido:** ainda assim
`);
    expect(a.decisions).toHaveLength(1);
    expect(a.decisions[0]?.escolhido).toBe('ainda assim');
    // A seção não bateu, então a UI sabe que não pode confiar no estruturado.
    expect(a.parsed).toBe(false);
    expect(a.missingSections).toEqual(['decisoes', 'riscos']);
    expect(a.warnings.join(' ')).toMatch(/fora de "## Decisões"/);
  });

  // ---- as entradas que não podem apagar a UI ----

  it('never throws on an empty, null or undefined brief', () => {
    for (const input of ['', '   \n  \n', null, undefined]) {
      const a = parseDebateBriefA(input);
      expect(a.present).toBe(false);
      expect(a.parsed).toBe(false);
      expect(a.decisions).toEqual([]);
      expect(a.risks).toEqual([]);
      expect(a.missingSections).toEqual(['decisoes', 'riscos']);
      expect(typeof a.raw).toBe('string');
    }
  });

  it('never throws on pure garbage and still hands the raw back', () => {
    const junk = 'Isto não é um brief.\n\n{"json": true}\n<html></html>\n\n\n';
    const a = parseDebateBriefA(junk);
    expect(a.present).toBe(true);
    expect(a.parsed).toBe(false);
    expect(a.decisions).toEqual([]);
    expect(a.missingSections).toEqual(['decisoes', 'riscos']);
    expect(a.raw).toBe(junk);
  });

  // O corte no meio de um bullet é o modo de falha REAL: timeout do agente,
  // teto de tokens, kill do memory-guard. O campo anterior não pode virar
  // lixo por causa disso.
  it('never throws on markdown truncated in the middle of a bullet', () => {
    const truncated = `## Decisões
### D1 — algo
- **Escolhido:** fazer X
- **Rejei`;
    const a = parseDebateBriefA(truncated);
    expect(a.raw).toBe(truncated);
    expect(a.decisions).toHaveLength(1);
    expect(a.decisions[0]?.escolhido).toBe('fazer X');
    expect(a.decisions[0]?.rejeitado).toBeNull();
    expect(a.parsed).toBe(false);
    expect(a.missingSections).toEqual(['riscos']);
  });

  it('caps the decision list and says so instead of growing without bound', () => {
    const lines = ['## Decisões'];
    for (let i = 1; i <= MAX_DECISIONS + 50; i++) {
      lines.push(`### D${i} — decisão ${i}`, `- **Escolhido:** ${'x'.repeat(20)}`, '');
    }
    lines.push('## Riscos assumidos', '- r');
    const a = parseDebateBriefA(lines.join('\n'));
    expect(a.decisions).toHaveLength(MAX_DECISIONS);
    expect(a.warnings.join(' ')).toMatch(/excedente foi ignorado/);
    expect(a.risks).toHaveLength(1);
  });

  it('truncates a brief past the size ceiling instead of choking on it', () => {
    const huge = `## Decisões\n### D1 — x\n- **Escolhido:** ${'a'.repeat(MAX_BRIEF_CHARS)}`;
    const a = parseDebateBriefA(huge);
    expect(a.truncated).toBe(true);
    expect(a.raw).toHaveLength(MAX_BRIEF_CHARS);
    expect(a.warnings.join(' ')).toMatch(/cortado/);
  });

  // VOLUME, não ReDoS: 100 KB distribuídos em muitas linhas médias. Este
  // teste passava em 3 ms COM as quatro regexes quadráticas dentro do módulo —
  // ele prova que o parser aguenta um brief grande, e nada além disso. A prova
  // contra ReDoS é o teste seguinte, e o gatilho é outro.
  it('parses ~100 KB of bulky markdown fast', () => {
    const chunks = ['## Decisões'];
    for (let i = 1; i <= 200; i++) {
      chunks.push(
        `### D${i} — ${'*'.repeat(40)}`,
        `- **Escolhido:** ${'a:'.repeat(60)}`,
        `- **Rejeitado:** ${'-'.repeat(120)}`,
        `- **Por quê:** ${'#'.repeat(120)}`,
        `- **Falsificaria:** ${'_'.repeat(120)}`,
        '',
      );
    }
    chunks.push(`- **Escolhido:** ${'b:'.repeat(20_000)}`);
    chunks.push('#'.repeat(3000));
    chunks.push('## Riscos assumidos', '- r');
    const md = chunks.join('\n');
    expect(md.length).toBeGreaterThan(100_000);
    const started = Date.now();
    const a = parseDebateBriefA(md);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(a.decisions).toHaveLength(200);
    expect(a.risks).toHaveLength(1);
  });

  // PROVA CONTRA ReDoS — a de verdade.
  //
  // São DUAS famílias, e o parser só tinha sido auditado contra uma. A famosa
  // é a exponencial (`(a+)+`), com quantificador aninhado, que este módulo
  // nunca teve. A outra é QUADRÁTICA e não tem grupo nenhum: `X+$` sem `^` faz
  // o motor tentar casar a partir de CADA posição da linha.
  //
  // O gatilho é sempre a mesma forma, e não é "muito texto": é UM RUN LONGO de
  // caracteres da classe seguido de UM caractere que NÃO é da classe, para que
  // todo começo de match percorra o run inteiro e só então falhe no `$`. Cada
  // linha abaixo mira uma das quatro regexes que o módulo tinha, e nenhuma
  // delas passa do teto de MAX_BRIEF_CHARS do próprio módulo — este é um brief
  // que o parser aceita inteiro, não um caso "grande demais".
  //
  // Medido antes da correção: 5 451 ms só na linha dos tabs, dezenas de
  // segundos no conjunto, e `buildDebateTranscript` faz isto DUAS vezes. Com a
  // varredura de índice: menos de 1 ms. Reverter qualquer uma das quatro
  // regexes derruba a asserção de 2 s abaixo.
  it('parses ReDoS-shaped markdown (long runs + one near-miss char) fast', () => {
    const RUN = 63_000;
    const md = [
      '## Decisões',
      // `[#\s]+$` (fecho de heading): run de TAB terminado por um não-`#`.
      `# ${'\t'.repeat(RUN)}x`,
      // `[\s*_\`]+$` (normalizeLabel): run de `*` terminado por uma letra.
      `## a${'*'.repeat(RUN)}b`,
      // `[\s?!.:;]+$` (normalizeLabel): run de `:` terminado por uma letra.
      `## c${':'.repeat(RUN)}d`,
      '### D1 — decisão real',
      '- **Escolhido:** um',
      // `\s+$` (o `raw` da decisão): o run de branco NÃO pode ser o fim do
      // bloco, senão o motor casa de primeira e o custo some.
      '\t'.repeat(RUN),
      'fim do bloco',
      '',
      '## Riscos assumidos',
      '- r',
    ].join('\n');
    expect(md.length).toBeGreaterThan(200_000);
    expect(md.length).toBeLessThan(MAX_BRIEF_CHARS);

    const started = Date.now();
    const a = parseDebateBriefA(md);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(a.truncated).toBe(false);
    expect(a.decisions).toHaveLength(1);
    expect(a.decisions[0]?.escolhido).toBe('um');
    expect(a.decisions[0]?.raw).toContain('fim do bloco');
    expect(a.risks).toHaveLength(1);
    expect(a.parsed).toBe(true);
  });

  // ---- a ênfase do VALOR (o contrato de stripValueEmphasis) ----

  // A FORMA QUE OS DOIS PROMPTS MAIS PRODUZEM: `Por quê` e `Evidência` mandam
  // CITAR UM CAMINHO, e modelo cita caminho entre crases. Comer só o marcador
  // de ABERTURA devolvia uma crase órfã no meio do valor — com `parsed: true`
  // e zero warnings, que é a corrupção mais difícil de ver.
  it('keeps inline emphasis that does not wrap the whole value, byte for byte', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- **Por quê:** \`.huu/dev/epoch-1/atlas.md\` separa api de cli
- **Escolhido:** **A** ou **B**
- **Rejeitado:** *estender* o schema
- **Falsificaria:** usar \`src/lib/x.ts\` como prova

## Riscos assumidos
- r
`);
    expect(a.decisions[0]?.porQue).toBe('\`.huu/dev/epoch-1/atlas.md\` separa api de cli');
    expect(a.decisions[0]?.escolhido).toBe('**A** ou **B**');
    expect(a.decisions[0]?.rejeitado).toBe('*estender* o schema');
    expect(a.decisions[0]?.falsificaria).toBe('usar \`src/lib/x.ts\` como prova');
    expect(a.parsed).toBe(true);
    expect(a.warnings).toEqual([]);
  });

  // O outro lado do contrato: um par que VESTE o valor inteiro cai — os DOIS
  // marcadores. Deixar o de fechamento para trás devolvia `x**`.
  it('strips an emphasis pair only when it wraps the whole value', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- **Escolhido:** **um**
- **Rejeitado**: __dois__
- **Por quê:** ***três***
- **Falsificaria:** \`quatro\`

## Riscos assumidos
- r
`);
    expect(a.decisions[0]).toMatchObject({
      escolhido: 'um',
      rejeitado: 'dois',
      porQue: 'três',
      falsificaria: 'quatro',
    });
    // O `**` do RÓTULO (dois-pontos DENTRO do negrito) some sem levar o valor
    // junto, e um valor sem par nenhum volta intocado.
    const b = parseDebateBriefA(`## Decisões
### D1 — x
- **Escolhido:** simples
- **Rejeitado:** \`p\` no começo da frase

## Riscos assumidos
- r
`);
    expect(b.decisions[0]?.escolhido).toBe('simples');
    expect(b.decisions[0]?.rejeitado).toBe('\`p\` no começo da frase');
  });

  // ---- tetos: cortar é o contrato; descartar é bug ----

  // Era o modo de falha SILENCIOSO mais grave: um valor de 4 001 caracteres
  // fazia `parseFieldLine` devolver `null`, e como campo é sempre bullet o
  // laço jogava a LINHA INTEIRA fora — campo `null`, `parsed: true`, nenhum
  // warning. A doc de MAX_FIELD_CHARS sempre disse "truncado, nunca
  // descartado"; agora o código diz o mesmo.
  it('truncates an over-long field value instead of dropping the whole line', () => {
    const prefix = '- **Escolhido:** ';
    const a = parseDebateBriefA(`## Decisões
### D1 — x
${prefix}${'a'.repeat(5_000)}
- **Rejeitado:** depois do gigante

## Riscos assumidos
- r
`);
    expect(a.decisions[0]?.escolhido).toBe('a'.repeat(MAX_LINE_CHARS - prefix.length));
    expect(a.decisions[0]?.escolhido?.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    // A linha gigante não contamina a seguinte.
    expect(a.decisions[0]?.rejeitado).toBe('depois do gigante');
    expect(a.warnings.join(' ')).toMatch(/campo "escolhido" de D1 truncado em 4000 caracteres/);
  });

  it('truncates a folded continuation at the field ceiling and says so', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- **Escolhido:** ${'a'.repeat(3_900)}
  ${'b'.repeat(300)}

## Riscos assumidos
- r
`);
    expect(a.decisions[0]?.escolhido).toHaveLength(MAX_FIELD_CHARS);
    expect(a.decisions[0]?.escolhido?.startsWith('a'.repeat(3_900))).toBe(true);
    expect(a.warnings.join(' ')).toMatch(/campo "escolhido" de D1 truncado/);
  });

  it('truncates an over-long decision title at the title ceiling and says so', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — ${'t'.repeat(MAX_TITLE_CHARS + 100)}
- **Escolhido:** um

## Riscos assumidos
- ${'r'.repeat(MAX_FIELD_CHARS + 100)}
`);
    expect(a.decisions[0]?.title).toBe('t'.repeat(MAX_TITLE_CHARS));
    expect(a.risks[0]?.text).toBe('r'.repeat(MAX_FIELD_CHARS));
    expect(a.warnings.join(' ')).toMatch(/título de D1 truncado em 400 caracteres/);
    expect(a.warnings.join(' ')).toMatch(/risco truncado em 4000 caracteres/);
  });

  // ---- a janela do rótulo ----

  // Um campo mora nos primeiros 80 caracteres antes do `:`; uma frase com um
  // `:` lá no fim não é campo. O run de `*` é o jeito de fazer o RÓTULO
  // normalizar para `escolhido` e mesmo assim estourar a janela — sem ele, o
  // teto não é observável.
  it('only reads a field when the colon fits in the 80-character label window', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- ${'*'.repeat(71)}Escolhido: no limite
- ${'*'.repeat(72)}Rejeitado: passou do limite

## Riscos assumidos
- r
`);
    expect(a.decisions[0]?.escolhido).toBe('no limite');
    expect(a.decisions[0]?.rejeitado).toBeNull();
  });

  // ---- o fim de linha que o módulo promete tolerar ----

  it('reads a brief whose lines end in a bare CR, and one in CRLF', () => {
    for (const eol of ['\r', '\r\n']) {
      const a = parseDebateBriefA(WELL_FORMED_A.split('\n').join(eol));
      expect(a.parsed).toBe(true);
      expect(a.decisions.map((d) => d.id)).toEqual(['D1', 'D2']);
      expect(a.decisions[0]?.escolhido).toBe('duas frentes, api e cli');
      expect(a.risks).toHaveLength(2);
    }
  });

  // ---- seção presente mas vazia ----

  // "Uma seção bateu" é sobre HEADING **e** CONTEÚDO: um `## Decisões` vazio é
  // um brief quebrado, não um brief curto, e a UI tem que cair no cru.
  it('treats an empty "## Decisões" as a broken brief, not a short one', () => {
    const a = parseDebateBriefA(`## Decisões

## Riscos assumidos
- r
`);
    expect(a.sections[0]).toEqual({ id: 'decisoes', found: true, entries: 0, expected: true });
    expect(a.missingSections).toEqual(['decisoes']);
    expect(a.parsed).toBe(false);
  });

  // O gêmeo, na outra direção: riscos NÃO exigem entrada. Um record com uma
  // decisão e nenhum risco assumido é um brief legítimo.
  it('accepts an empty "## Riscos assumidos"', () => {
    const a = parseDebateBriefA(`## Decisões
### D1 — x
- **Escolhido:** um

## Riscos assumidos
`);
    expect(a.sections[1]).toEqual({ id: 'riscos', found: true, entries: 0, expected: true });
    expect(a.missingSections).toEqual([]);
    expect(a.parsed).toBe(true);
  });
});

// ─────────────────────────── brief B ────────────────────────────────────────

describe('parseDebateBriefB', () => {
  it('extracts every verdict and every objection from a well-formed attack', () => {
    const b = parseDebateBriefB(WELL_FORMED_B);
    expect(b.side).toBe('B');
    expect(b.present).toBe(true);
    expect(b.parsed).toBe(true);
    expect(b.missingSections).toEqual([]);
    expect(b.verdicts).toEqual([
      {
        decisionId: 'D1',
        label: 'SUSTENTADA',
        reason: 'a separação bate com o mapa de arquivos do atlas',
        raw: '- D1: SUSTENTADA — a separação bate com o mapa de arquivos do atlas',
      },
      {
        decisionId: 'D2',
        label: 'CONTESTADA',
        reason: 'estender o schema quebra o parse dos pipelines já salvos',
        raw: '- D2: CONTESTADA — estender o schema quebra o parse dos pipelines já salvos',
      },
    ]);
    expect(b.objections).toHaveLength(1);
    expect(b.objections[0]).toMatchObject({
      decisionId: 'D2',
      falhaPrevista: 'PipelineSchema.safeParse falha em qualquer arquivo salvo antes da v2',
      evidencia: 'src/lib/pipeline-io.ts, e registry.test.ts cobre o round-trip',
      alternativaMaisBarata: 'adicionar o campo como opcional e defaultar no parse',
    });
    expect(b.objections[0]?.raw.startsWith('### D2')).toBe(true);
    expect(b.raw).toBe(WELL_FORMED_B);
  });

  it('tolerates case, accents, dashes and marker placement on the verdict line', () => {
    const b = parseDebateBriefB(`## VEREDITO POR DECISÃO
- **D1** - Sustentado: nenhuma objeção encontrada
- d10 – CONTESTADA — quebra o build
* D2 : contestada — outra falha
`);
    expect(b.verdicts.map((v) => [v.decisionId, v.label, v.reason])).toEqual([
      ['D1', 'SUSTENTADA', 'nenhuma objeção encontrada'],
      ['D10', 'CONTESTADA', 'quebra o build'],
      ['D2', 'CONTESTADA', 'outra falha'],
    ]);
    // Contestou e não abriu "## Objeções": é exatamente a cláusula que o
    // portão recusa, e a UI precisa saber disso.
    expect(b.parsed).toBe(false);
    expect(b.missingSections).toEqual(['objecoes']);
  });

  // Sem CONTESTADA, "## Objeções" não é exigida — a mesma regra do juiz.
  it('does not demand an objections section when nothing was contested', () => {
    const b = parseDebateBriefB(`## Veredito por decisão
- D1: SUSTENTADA — tudo certo
- D2: SUSTENTADA — idem
`);
    expect(b.parsed).toBe(true);
    expect(b.missingSections).toEqual([]);
    expect(b.sections[1]).toEqual({ id: 'objecoes', found: false, entries: 0, expected: false });
  });

  it('records an unreadable verdict label as null and warns', () => {
    const b = parseDebateBriefB(`## Veredito por decisão
- D3: TALVEZ — não consegui decidir
`);
    expect(b.verdicts[0]?.label).toBeNull();
    expect(b.verdicts[0]?.reason).toBe('TALVEZ — não consegui decidir');
    expect(b.verdicts[0]?.raw).toBe('- D3: TALVEZ — não consegui decidir');
    expect(b.warnings.join(' ')).toMatch(/sem SUSTENTADA\/CONTESTADA legível/);
  });

  it('folds a wrapped objection field instead of dropping it', () => {
    const b = parseDebateBriefB(`## Veredito por decisão
- D1: CONTESTADA — quebra

## Objeções
### D1
- **Falha prevista:** primeira linha
  segunda linha
- **Evidência:** src/lib/x.ts
`);
    expect(b.objections[0]?.falhaPrevista).toBe('primeira linha\nsegunda linha');
    expect(b.objections[0]?.evidencia).toBe('src/lib/x.ts');
    expect(b.objections[0]?.alternativaMaisBarata).toBeNull();
  });

  it('never throws on an empty, null or undefined brief', () => {
    for (const input of ['', '  \n', null, undefined]) {
      const b = parseDebateBriefB(input);
      expect(b.present).toBe(false);
      expect(b.parsed).toBe(false);
      expect(b.verdicts).toEqual([]);
      expect(b.objections).toEqual([]);
      expect(b.missingSections).toEqual(['veredito']);
    }
  });

  it('never throws on pure garbage and still hands the raw back', () => {
    const junk = 'sem seção nenhuma\nD nada disso\n- 42: talvez\n';
    const b = parseDebateBriefB(junk);
    expect(b.present).toBe(true);
    expect(b.parsed).toBe(false);
    expect(b.verdicts).toEqual([]);
    expect(b.missingSections).toEqual(['veredito']);
    expect(b.raw).toBe(junk);
  });

  it('never throws on markdown truncated in the middle of a bullet', () => {
    const truncated = `## Veredito por decisão
- D1: SUSTENTADA — ok

## Objeções
### D2
- **Falha prev`;
    const b = parseDebateBriefB(truncated);
    expect(b.raw).toBe(truncated);
    expect(b.verdicts).toHaveLength(1);
    expect(b.objections).toHaveLength(1);
    expect(b.objections[0]?.falhaPrevista).toBeNull();
    expect(b.parsed).toBe(true); // nada contestado ⇒ nada faltando
  });

  it('parses ~100 KB of adversarial verdict lines fast', () => {
    const chunks = ['## Veredito por decisão'];
    for (let i = 1; i <= 700; i++) {
      chunks.push(`- D${i}: CONTESTADA — ${'x:'.repeat(60)}`);
    }
    chunks.push('## Objeções');
    for (let i = 1; i <= 100; i++) {
      chunks.push(`### D${i}`, `- **Evidência:** ${'*'.repeat(120)}`);
    }
    const md = chunks.join('\n');
    expect(md.length).toBeGreaterThan(100_000);
    const started = Date.now();
    const b = parseDebateBriefB(md);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(b.verdicts).toHaveLength(MAX_VERDICTS);
    expect(b.warnings.join(' ')).toMatch(/excedente foi ignorado/);
    expect(b.objections).toHaveLength(100);
  });

  // O gêmeo do teste de ReDoS do brief A — `buildDebateTranscript` parseia os
  // DOIS lados, então um lado linear e outro quadrático ainda trava a UI.
  it('parses ReDoS-shaped markdown (long runs + one near-miss char) fast', () => {
    const RUN = 63_000;
    const md = [
      '## Veredito por decisão',
      `# ${'\t'.repeat(RUN)}x`,
      `## a${'*'.repeat(RUN)}b`,
      '- D1: CONTESTADA — quebra o build',
      '## Objeções',
      `## c${':'.repeat(RUN)}d`,
      '### D1',
      '- **Evidência:** src/lib/x.ts',
      '\t'.repeat(RUN),
      'fim do bloco',
    ].join('\n');
    expect(md.length).toBeGreaterThan(200_000);
    expect(md.length).toBeLessThan(MAX_BRIEF_CHARS);

    const started = Date.now();
    const b = parseDebateBriefB(md);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(b.truncated).toBe(false);
    expect(b.verdicts).toHaveLength(1);
    expect(b.verdicts[0]?.label).toBe('CONTESTADA');
    expect(b.objections).toHaveLength(1);
    expect(b.objections[0]?.evidencia).toBe('src/lib/x.ts');
    expect(b.objections[0]?.raw).toContain('fim do bloco');
    expect(b.parsed).toBe(true);
  });

  // A mesma regra de A: heading sem conteúdo não é seção que bateu.
  it('treats an empty "## Veredito por decisão" as a broken brief', () => {
    const b = parseDebateBriefB(`## Veredito por decisão

## Objeções
`);
    expect(b.sections[0]).toEqual({ id: 'veredito', found: true, entries: 0, expected: true });
    expect(b.missingSections).toEqual(['veredito']);
    expect(b.parsed).toBe(false);
  });

  it('truncates an over-long verdict line instead of dropping it', () => {
    const b = parseDebateBriefB(`## Veredito por decisão
- D1: CONTESTADA — ${'x'.repeat(MAX_FIELD_CHARS + 500)}
`);
    expect(b.verdicts).toHaveLength(1);
    expect(b.verdicts[0]?.reason).toBe('x'.repeat(MAX_FIELD_CHARS));
    expect(b.verdicts[0]?.raw).toHaveLength(MAX_FIELD_CHARS);
    expect(b.warnings.join(' ')).toMatch(/veredito de D1 truncado em 4000 caracteres/);
  });
});

// ─────────────────────────── o transcript ───────────────────────────────────

describe('buildDebateTranscript', () => {
  it('joins each decision with the verdict and the objection about it', () => {
    const t = buildDebateTranscript({ a: WELL_FORMED_A, b: WELL_FORMED_B });
    expect(t.format).toBe('huu-debate-transcript-v1');
    expect(t.parsed).toBe(true);
    expect(t.exchanges).toHaveLength(2);
    expect(t.exchanges[0]?.decisionId).toBe('D1');
    expect(t.exchanges[0]?.verdict?.label).toBe('SUSTENTADA');
    expect(t.exchanges[0]?.objection).toBeNull();
    expect(t.exchanges[1]?.verdict?.label).toBe('CONTESTADA');
    expect(t.exchanges[1]?.objection?.decisionId).toBe('D2');
    expect(t.contestedDecisionIds).toEqual(['D2']);
    expect(t.unjudgedDecisionIds).toEqual([]);
    expect(t.orphanVerdictIds).toEqual([]);
  });

  // A cláusula de COBERTURA do portão, vista do lado da UI.
  it('reports decisions nobody judged and verdicts about decisions nobody made', () => {
    const t = buildDebateTranscript({
      a: `## Decisões
### D1 — x
- **Escolhido:** um
### D2 — y
- **Escolhido:** dois

## Riscos assumidos
- r
`,
      b: `## Veredito por decisão
- D1: SUSTENTADA — ok
- D9: CONTESTADA — sobre uma decisão que ninguém tomou
`,
    });
    expect(t.unjudgedDecisionIds).toEqual(['D2']);
    expect(t.orphanVerdictIds).toEqual(['D9']);
    expect(t.exchanges.map((e) => e.decisionId)).toEqual(['D1', 'D2', 'D9']);
    expect(t.exchanges[1]?.verdict).toBeNull();
    expect(t.exchanges[2]?.decision).toBeNull();
  });

  // UM ID, UM TURNO — e a repetição não some calada. Vale nas duas direções:
  // ids distintos rendem um turno cada, ids repetidos colapsam no PRIMEIRO e a
  // diferença de contagem é exatamente o que os warnings dos briefs explicam.
  it('collapses a repeated id into one exchange, and says so in the briefs', () => {
    const t = buildDebateTranscript({
      a: `## Decisões
### D1 — primeira
- **Escolhido:** um
### D1 — segunda
- **Escolhido:** dois

## Riscos assumidos
- r
`,
      b: `## Veredito por decisão
- D1: CONTESTADA — quebra
- D1: CONTESTADA — de novo
- D9: CONTESTADA — sobre decisão que ninguém tomou
- D9: CONTESTADA — de novo
`,
    });
    expect(t.exchanges.map((e) => e.decisionId)).toEqual(['D1', 'D9']);
    // Vale o PRIMEIRO de cada lado.
    expect(t.exchanges[0]?.decision?.title).toBe('primeira');
    expect(t.exchanges[0]?.verdict?.reason).toBe('quebra');
    // O conteúdo repetido continua visível — no brief e no warning.
    expect(t.advocate.decisions).toHaveLength(2);
    expect(t.prosecutor.verdicts).toHaveLength(4);
    expect(t.advocate.warnings.join(' ')).toMatch(/D1 declarada mais de uma vez/);
    expect(t.prosecutor.warnings.join(' ')).toMatch(/veredito de D1 declarado mais de uma vez/);
    // Os TRÊS índices de id seguem a MESMA regra — nenhum repete.
    expect(t.contestedDecisionIds).toEqual(['D1', 'D9']);
    expect(t.orphanVerdictIds).toEqual(['D9']);
    expect(t.unjudgedDecisionIds).toEqual([]);
  });

  it('keeps one exchange per distinct id when nothing repeats', () => {
    const t = buildDebateTranscript({
      a: `## Decisões
### D1 — um
- **Escolhido:** a
### D2 — dois
- **Escolhido:** b

## Riscos assumidos
- r
`,
      b: `## Veredito por decisão
- D1: CONTESTADA — x
- D2: CONTESTADA — y
`,
    });
    expect(t.exchanges.map((e) => e.decisionId)).toEqual(['D1', 'D2']);
    expect(t.contestedDecisionIds).toEqual(['D1', 'D2']);
  });

  it('never throws when one side, or neither, exists', () => {
    const onlyA = buildDebateTranscript({ a: WELL_FORMED_A });
    expect(onlyA.parsed).toBe(false);
    expect(onlyA.prosecutor.present).toBe(false);
    expect(onlyA.exchanges).toHaveLength(2);
    expect(onlyA.unjudgedDecisionIds).toEqual(['D1', 'D2']);

    const onlyB = buildDebateTranscript({ a: null, b: WELL_FORMED_B });
    expect(onlyB.parsed).toBe(false);
    expect(onlyB.advocate.present).toBe(false);
    expect(onlyB.orphanVerdictIds).toEqual(['D1', 'D2']);

    const neither = buildDebateTranscript({});
    expect(neither.parsed).toBe(false);
    expect(neither.exchanges).toEqual([]);
    expect(neither.advocate.raw).toBe('');
    expect(neither.prosecutor.raw).toBe('');
  });
});

// ─────────────────── o localizador dentro do pipeline ───────────────────────

function front(id: string): DevFront {
  return {
    id,
    title: `Front ${id}`,
    rationale: `porque ${id}`,
    dependsOnFronts: [],
    reconPrompt: `mapeie ${id}`,
    workPrompt: `implemente ${id}`,
    verifyCondition: `${id} está pronto`,
    maxTasks: 4,
  };
}

function plan(fronts: DevFront[]): DevPlan {
  return {
    epochGoal: 'entregar a fatia 1',
    doneWhen: 'os testes passam',
    goalComplete: false,
    fronts,
  };
}

describe('findDebateSteps', () => {
  // O caso PADRÃO: `--debate` vem desligado.
  it('returns null for a pipeline compiled without the debate', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a'), front('b')]),
      epoch: 1,
      goal: 'construir a coisa',
    });
    expect(findDebateSteps(pipeline)).toBeNull();
    expect(hasDebate(pipeline)).toBe(false);
    expect(debateRoleOfStep(pipeline, '0. Recon do objetivo')).toBeNull();
  });

  it('returns null for an absent, empty or malformed pipeline', () => {
    expect(findDebateSteps(null)).toBeNull();
    expect(findDebateSteps(undefined)).toBeNull();
    expect(findDebateSteps({ name: 'x', steps: [] })).toBeNull();
    expect(hasDebate(null)).toBe(false);
    expect(debateRoleOfStep(null, 'qualquer')).toBeNull();
  });

  it('identifies the three roles in a pipeline compiled WITH the debate', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a'), front('b')]),
      epoch: 1,
      goal: 'construir a coisa',
      methodology: { debate: true },
    });
    const found = findDebateSteps(pipeline);
    expect(found).not.toBeNull();
    if (!found) return;
    expect(found.matchedBy).toBe('name');
    expect(found.names).toEqual({
      advocate: DEBATE_ADVOCATE_STEP_NAME,
      prosecutor: DEBATE_PROSECUTOR_STEP_NAME,
      gate: DEBATE_GATE_STEP_NAME,
    });
    expect(found.advocate.type).toBe('work');
    expect(found.prosecutor.dependsOn).toContain(DEBATE_ADVOCATE_STEP_NAME);
    expect(found.gate.type).toBe('check');
    expect(found.gate.outcomes.map((o) => o.label)).toEqual(['convergiu', 'contestado']);
    expect(found.briefPaths).toEqual({
      a: '.huu/dev/epoch-1/debate/A.md',
      b: '.huu/dev/epoch-1/debate/B.md',
    });
    expect(hasDebate(pipeline)).toBe(true);
  });

  it('follows the session namespace into the brief paths', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a')]),
      epoch: 3,
      goal: 'g',
      sessionId: 'sess-1',
      methodology: { debate: true },
    });
    expect(findDebateSteps(pipeline)?.briefPaths).toEqual({
      a: '.huu/dev/sess-1/epoch-3/debate/A.md',
      b: '.huu/dev/sess-1/epoch-3/debate/B.md',
    });
  });

  it('maps a step name to its side of the debate', () => {
    const { pipeline } = compileEpochPipeline({
      plan: plan([front('a')]),
      epoch: 1,
      goal: 'g',
      methodology: { debate: true },
    });
    expect(debateRoleOfStep(pipeline, DEBATE_ADVOCATE_STEP_NAME)).toBe('advocate');
    expect(debateRoleOfStep(pipeline, DEBATE_PROSECUTOR_STEP_NAME)).toBe('prosecutor');
    expect(debateRoleOfStep(pipeline, DEBATE_GATE_STEP_NAME)).toBe('gate');
    expect(debateRoleOfStep(pipeline, '0. Recon do objetivo')).toBeNull();
    expect(debateRoleOfStep(pipeline, '')).toBeNull();
    expect(debateRoleOfStep(pipeline, null)).toBeNull();
  });

  // O nome do passo é a âncora frágil. Quando ele muda, a estrutura ainda
  // identifica os três — é o que evita que um rename apague o debate da UI.
  function renamedDebatePipeline(reversed = false): Pipeline {
    const advocate = {
      type: 'work' as const,
      name: 'Defend the choices',
      prompt: 'escreva `.huu/dev/epoch-2/debate/A.md`',
      files: [],
      scope: 'project' as const,
      writes: ['.huu/dev/epoch-2/debate/**'],
      dependsOn: ['0. Recon'],
    };
    const prosecutor = {
      type: 'work' as const,
      name: 'Attack the choices',
      prompt: 'escreva B.md',
      files: [],
      scope: 'project' as const,
      writes: ['.huu/dev/epoch-2/debate/**'],
      dependsOn: ['Defend the choices'],
    };
    const gate = {
      type: 'check' as const,
      name: 'Settled?',
      condition: 'convergiu?',
      dependsOn: ['Attack the choices'],
      outcomes: [
        { label: 'convergiu', nextStepName: '1a. front', default: true },
        { label: 'contestado', nextStepName: 'Defend the choices' },
      ],
    };
    const pair = reversed ? [prosecutor, advocate] : [advocate, prosecutor];
    return {
      name: 'renamed',
      steps: [
        { type: 'work', name: '0. Recon', prompt: 'p', files: [] },
        ...pair,
        gate,
        { type: 'work', name: '1a. front', prompt: 'p', files: [] },
      ],
    };
  }

  it('falls back to the write-set + dependency structure when the names change', () => {
    const found = findDebateSteps(renamedDebatePipeline());
    expect(found).not.toBeNull();
    if (!found) return;
    expect(found.matchedBy).toBe('structure');
    expect(found.names).toEqual({
      advocate: 'Defend the choices',
      prosecutor: 'Attack the choices',
      gate: 'Settled?',
    });
    expect(found.briefPaths).toEqual({
      a: '.huu/dev/epoch-2/debate/A.md',
      b: '.huu/dev/epoch-2/debate/B.md',
    });
    expect(debateRoleOfStep(renamedDebatePipeline(), 'Attack the choices')).toBe('prosecutor');
  });

  it('reads the sides from dependsOn, not from array order', () => {
    const found = findDebateSteps(renamedDebatePipeline(true));
    expect(found?.names.advocate).toBe('Defend the choices');
    expect(found?.names.prosecutor).toBe('Attack the choices');
  });

  // O fallback estrutural só aceita como portão um check que declare OS DOIS
  // rótulos do debate — é o que impede a UI de apontar para qualquer gate que
  // por acaso rode depois do promotor. É também o que o comentário do módulo
  // dizia errado ("ou os rótulos"): quem manda é o código, e o código exige.
  it('refuses a gate that does not declare BOTH debate outcome labels', () => {
    const variants: CheckOutcome[][] = [
      [{ label: 'ok', nextStepName: '1a. front', default: true }],
      [{ label: 'convergiu', nextStepName: '1a. front', default: true }],
      [{ label: 'contestado', nextStepName: 'Defend the choices', default: true }],
    ];
    for (const outcomes of variants) {
      const pipeline = renamedDebatePipeline();
      const gate = pipeline.steps[3]!;
      expect(gate.type).toBe('check');
      if (gate.type !== 'check') return;
      gate.outcomes = outcomes;
      expect(findDebateSteps(pipeline)).toBeNull();
      expect(hasDebate(pipeline)).toBe(false);
    }
  });

  // Meio debate não é debate: a UI não pode renderizar um lado que não existe.
  it('returns null when only part of the block is identifiable', () => {
    const half: Pipeline = {
      name: 'half',
      steps: [
        {
          type: 'work',
          name: 'Defend the choices',
          prompt: 'p',
          files: [],
          writes: ['.huu/dev/epoch-2/debate/**'],
        },
        { type: 'work', name: 'outro', prompt: 'p', files: [] },
      ],
    };
    expect(findDebateSteps(half)).toBeNull();
    expect(hasDebate(half)).toBe(false);
  });
});
