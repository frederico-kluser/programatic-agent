// O MODELO DE DADOS DO DEBATE — o que os dois briefs (`A.md` / `B.md`) querem
// dizer, e onde o debate mora dentro de um `Pipeline` já compilado.
//
// O debate adversarial (`--debate`) é compilado por `plan-to-pipeline.ts` como
// um bloco de três nós entre o recon global e o fan-out das frentes:
//
//   Sustentar as escolhas   (work) → escreve <epoch>/debate/A.md   (o RECORD)
//   Contestar as escolhas   (work) → escreve <epoch>/debate/B.md   (o ATAQUE)
//   Debate resolvido?       (check) → convergiu (default, forward) | contestado
//
// O canal de saída do debate é ARQUIVO: `CheckEvaluationResult.reason` nunca
// chega ao prompt do passo seguinte, então tudo o que as duas partes produzem
// vive nesses dois markdowns. Este módulo é a única leitura estruturada deles.
//
// TRÊS REGRAS QUE ESTE MÓDULO NÃO NEGOCIA:
//
// 1. O PARSER NUNCA LANÇA. Os dois arquivos são prosa de LLM: podem vir
//    vazios, truncados no meio de um bullet, com uma seção a mais, com `D10`
//    antes de `D2`, ou não vir. Um `throw` aqui apagaria a UI no meio de um
//    debate — e a UI é justamente onde o humano descobre que o brief saiu
//    torto. Toda falha vira `parsed: false` + `missingSections` + um warning.
// 2. O CRU É PRESERVADO SEMPRE, mesmo quando o parse é perfeito. É o fallback
//    de renderização e é a prova para o usuário: o que a UI mostra tem que ser
//    conferível contra o que o agente realmente escreveu.
// 3. TEXTO DE LLM É ENTRADA NÃO CONFIÁVEL. Nada de `eval`; nenhuma regex com
//    backtracking exponencial (`(a+)+`) NEM quadrático (`X+$` sem `^` — a
//    segunda família, que quase passou batida aqui; ver "primitivas de
//    texto"); a varredura é LINHA A LINHA; e teto explícito em tudo o que
//    cresce — caracteres, linhas, decisões, vereditos, objeções, warnings.
//    Tudo o que passa de um teto é CORTADO com aviso, nunca descartado em
//    silêncio: um campo que some sem warning é pior que um campo cortado.
//
// Camada: `lib/` puro. Sem I/O, sem git, sem orquestrador. Quem lê os arquivos
// do disco (TUI) ou os serve por HTTP (web) chama isto com o conteúdo em mão.

import { isCheckStep, isWorkStep } from '../types.js';
import type { CheckStep, Pipeline, PipelineStep, WorkStep } from '../types.js';

// ─────────────────────────────── tetos ──────────────────────────────────────
//
// Todos são constantes exportadas e não knobs: a UI precisa saber onde o corte
// aconteceu para dizê-lo, e um teto negociável em runtime é um teto que o
// texto do modelo consegue empurrar.

/** Markdown máximo que um brief contribui. Acima disso o cru é CORTADO (nunca recusado). */
export const MAX_BRIEF_CHARS = 262_144;

/** Linhas máximas varridas por brief. O resto entra no cru mas não é interpretado. */
export const MAX_BRIEF_LINES = 20_000;

/**
 * Quanto de UMA linha é interpretado ao casar um campo. O excedente é cortado
 * do VALOR — com warning, e nunca descartando a linha (o cru fica inteiro).
 */
export const MAX_LINE_CHARS = 4_000;

/** Teto de decisões extraídas de `A.md` (o prompt pede no máximo 6). */
export const MAX_DECISIONS = 200;

/** Teto de riscos assumidos extraídos de `A.md`. */
export const MAX_RISKS = 200;

/** Teto de vereditos extraídos de `B.md`. */
export const MAX_VERDICTS = 200;

/** Teto de objeções extraídas de `B.md` (o prompt pede no máximo 4 CONTESTADA). */
export const MAX_OBJECTIONS = 200;

/** Teto por campo (`Escolhido`, `Evidência`, …). Excedente é truncado, nunca descartado. */
export const MAX_FIELD_CHARS = 4_000;

/** Teto do título de uma decisão. */
export const MAX_TITLE_CHARS = 400;

/** Teto de warnings por brief — um brief patológico não pode gerar uma lista infinita. */
export const MAX_WARNINGS = 50;

/** Marcador de formato, para o dia em que a forma mudar e um cliente antigo precisar recusar. */
export const DEBATE_TRANSCRIPT_FORMAT = 'huu-debate-transcript-v1';

// ─────────────────────────────── tipos ──────────────────────────────────────

/** As quatro seções que os dois esqueletos declaram. */
export type DebateSectionId = 'decisoes' | 'riscos' | 'veredito' | 'objecoes';

/** Qual lado escreveu. `A` sustenta (o record), `B` contesta (o ataque). */
export type DebateSide = 'A' | 'B';

/**
 * O veredito de B sobre uma decisão de A. `null` quando a linha tinha um id
 * reconhecível mas nenhum rótulo que este módulo saiba ler — a linha crua
 * continua no veredito para a UI mostrar.
 */
export type DebateVerdictLabel = 'SUSTENTADA' | 'CONTESTADA';

/** Uma decisão do record (`## Decisões` → `### D1 — …`). */
export interface DebateDecision {
  /** Normalizado para `D<n>` (o `d 10` do modelo vira `D10`). */
  id: string;
  /** A frase depois do id no heading. Vazia quando o heading era só o id. */
  title: string;
  escolhido: string | null;
  rejeitado: string | null;
  porQue: string | null;
  falsificaria: string | null;
  /** O bloco markdown desta decisão, verbatim. */
  raw: string;
}

/** Um risco assumido (`## Riscos assumidos`). */
export interface DebateRisk {
  text: string;
}

/** Uma linha de `## Veredito por decisão`. */
export interface DebateVerdict {
  decisionId: string;
  label: DebateVerdictLabel | null;
  /** A justificativa de uma linha que vem depois do rótulo. */
  reason: string;
  /** A linha inteira, verbatim. */
  raw: string;
}

/** Uma entrada de `## Objeções` (`### D2` + os três campos). */
export interface DebateObjection {
  decisionId: string;
  falhaPrevista: string | null;
  evidencia: string | null;
  alternativaMaisBarata: string | null;
  raw: string;
}

/**
 * Saúde de UMA seção. `found` é sobre o HEADING; `entries` é sobre o conteúdo.
 * `expected` diz se o esqueleto exigia a seção neste brief — em `B.md`,
 * `## Objeções` só é exigida quando existe pelo menos um CONTESTADA, que é
 * exatamente a cláusula que o juiz do portão verifica.
 */
export interface DebateSectionReport {
  id: DebateSectionId;
  found: boolean;
  entries: number;
  expected: boolean;
}

/** O que os dois briefs têm em comum. */
interface DebateBriefBase {
  side: DebateSide;
  /** O markdown cru, sempre (cortado em {@link MAX_BRIEF_CHARS}). */
  raw: string;
  /** `false` quando não havia arquivo, ou o arquivo era só espaço em branco. */
  present: boolean;
  /** O cru bateu no teto e foi cortado. */
  truncated: boolean;
  sections: DebateSectionReport[];
  /** Seções esperadas que não bateram — o sinal que decide estruturado vs cru. */
  missingSections: DebateSectionId[];
  /** `true` quando todas as seções esperadas bateram. */
  parsed: boolean;
  /** Reparos e suspeitas do parse, em prosa curta. Nunca fatais. */
  warnings: string[];
}

/** `A.md` — o record de decisões. */
export interface DebateBriefA extends DebateBriefBase {
  side: 'A';
  decisions: DebateDecision[];
  risks: DebateRisk[];
}

/** `B.md` — o ataque ao record. */
export interface DebateBriefB extends DebateBriefBase {
  side: 'B';
  verdicts: DebateVerdict[];
  objections: DebateObjection[];
}

/**
 * Uma decisão com o que o outro lado disse dela — a unidade que as duas
 * superfícies renderizam como turno de conversa. Qualquer um dos três campos
 * pode ser `null`: um id que só B menciona vira um turno sem decisão (o
 * "veredito órfão"), e uma decisão que ninguém julgou vira um turno sem
 * veredito, que é justamente a falha de COBERTURA que o portão existe para
 * pegar.
 */
export interface DebateExchange {
  decisionId: string;
  decision: DebateDecision | null;
  verdict: DebateVerdict | null;
  objection: DebateObjection | null;
}

/**
 * O debate inteiro, na forma que as UIs consomem.
 *
 * UM ID, UM TURNO. Os três índices de id abaixo são DEDUPLICADOS e ordenados
 * pela primeira aparição — a mesma regra nos três, porque uma UI que itera os
 * três não pode ter que lembrar qual deles repete. Quando um lado declara o
 * mesmo id duas vezes (A com dois `### D1`, B com dois vereditos de `D1`), a
 * PRIMEIRA ocorrência é a que vira turno; a repetição continua visível de dois
 * jeitos, e nenhum deles é silencioso: o brief do lado que repetiu traz o
 * warning "declarada/declarado mais de uma vez", e o `raw` do brief traz o
 * texto inteiro. É por isso que `advocate.decisions.length` pode ser MAIOR que
 * `exchanges.length` — a diferença é exatamente o que o warning conta.
 */
export interface DebateTranscript {
  format: typeof DEBATE_TRANSCRIPT_FORMAT;
  advocate: DebateBriefA;
  prosecutor: DebateBriefB;
  /** Na ordem em que A declarou; vereditos órfãos vêm no fim. Um turno por id. */
  exchanges: DebateExchange[];
  /** Ids declarados em A que B não julgou (cláusula 2 do portão). Sem repetição. */
  unjudgedDecisionIds: string[];
  /** Ids julgados em B que A nunca declarou. Sem repetição. */
  orphanVerdictIds: string[];
  /** Ids com veredito CONTESTADA, na ordem de B. Sem repetição. */
  contestedDecisionIds: string[];
  /** `true` só quando os DOIS briefs estão presentes e completos. */
  parsed: boolean;
}

// ───────────────────────── primitivas de texto ──────────────────────────────
//
// SÃO DUAS FAMÍLIAS DE ReDoS, NÃO UMA — e este módulo já foi mordido pela
// segunda. A famosa é a EXPONENCIAL, com quantificador aninhado (`(a+)+$`), e
// nenhuma regex daqui jamais teve isso. A outra é QUADRÁTICA e não tem grupo
// nenhum: `[\s*_`]+$` é `X+$` SEM âncora à esquerda, então o motor tenta casar
// a partir de CADA posição da linha; num run de 100 000 espaços seguido de UM
// caractere que não casa, cada uma das 100 000 posições percorre o run inteiro
// antes de falhar no `$`. Medido neste módulo, com as regexes antigas:
//
//   '# ' + '\t'×100 KB + 'x'  ..............  5 451 ms   (era `[#\s]+$`)
//   '# ' + ' '×100 KB  + '?'  ..............  3 980 ms
//   100 KB de branco num bloco de decisão ..  4 024 ms   (era `\s+$`)
//   o mesmo no teto de MAX_BRIEF_CHARS ..... 35 680 ms
//
// e `buildDebateTranscript` parseia os DOIS lados: ~71 s de event loop parado,
// que é exatamente a UI apagada que a regra 1 lá em cima existe para impedir.
// As mesmas amostras com a varredura de índice abaixo: 0,5 ms.
//
// Por isso TODO corte de borda aqui é VARREDURA DE ÍNDICE, não regex: uma
// passada da direita para a esquerda, O(n) e sem backtracking possível. As
// regexes que sobraram são todas ancoradas em `^` (uma única posição de
// início) ou classes de caractere único com `g` (lineares por construção).
//
// REGRA PARA QUEM MEXER AQUI: nenhuma regex nova pode terminar em `+$` ou `*$`
// sem `^` no começo. Corte de borda usa `trimEnd()` ou {@link trimEndWhile}.

const LEADING_EMPHASIS = /^[\s*_`]+/;
const LEADING_SEPARATORS = /^[\s*_`:.\-–—)\]|]+/;
const DIACRITICS = /[\u0300-\u036f]/g;
const BULLET = /^[\s]{0,8}[-*+•]\s+/;
const DECISION_ID = /^[*_`\s]{0,4}[dD][ \t]{0,2}(\d{1,4})/;
const WHITESPACE_CHAR = /\s/;

/**
 * O mesmo conjunto que `\s` casa — que é, byte a byte, o mesmo que
 * `String.prototype.trimEnd` remove (WhiteSpace ∪ LineTerminator).
 */
function isSpace(ch: string): boolean {
  return WHITESPACE_CHAR.test(ch);
}

/**
 * `trimEnd` genérico: anda do FIM para o começo enquanto o predicado casar.
 * É o substituto LINEAR das regexes `[...]+$` que este módulo tinha.
 */
function trimEndWhile(text: string, matches: (ch: string) => boolean): string {
  let end = text.length;
  while (end > 0 && matches(text[end - 1]!)) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** Equivalente exato de `/[\s*_`]+$/`, sem o custo quadrático. */
function trimTrailingEmphasis(text: string): string {
  return trimEndWhile(text, (ch) => ch === '*' || ch === '_' || ch === '`' || isSpace(ch));
}

/** Equivalente exato de `/[\s?!.:;]+$/`. */
function trimTrailingPunct(text: string): string {
  return trimEndWhile(
    text,
    (ch) => ch === '?' || ch === '!' || ch === '.' || ch === ':' || ch === ';' || isSpace(ch),
  );
}

/** Equivalente exato de `/[#\s]+$/` — os `#` de fechamento de um heading. */
function trimTrailingHashes(text: string): string {
  return trimEndWhile(text, (ch) => ch === '#' || isSpace(ch));
}

/** minúsculas, sem acento, sem pontuação de borda, espaços colapsados. */
function normalizeLabel(input: string): string {
  const folded = input
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(LEADING_EMPHASIS, '');
  return trimTrailingPunct(trimTrailingEmphasis(folded))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Os marcadores que um valor pode vestir, do mais longo para o mais curto. */
const VALUE_EMPHASIS_MARKERS = ['**', '__', '*', '_', '`'] as const;

/**
 * Peela UM par ABRE+FECHA que veste o valor INTEIRO. `null` quando não há par
 * a tirar — inclusive quando o marcador de abertura fecha ANTES do fim.
 */
function peelEmphasisPair(value: string): string | null {
  for (const marker of VALUE_EMPHASIS_MARKERS) {
    if (value.length <= marker.length * 2) continue;
    if (!value.startsWith(marker) || !value.endsWith(marker)) continue;
    const inner = value.slice(marker.length, value.length - marker.length);
    // O par tem que envolver o valor TODO: se o marcador reaparece no meio, o
    // de abertura fecha lá e não aqui.
    if (inner.includes(marker)) return null;
    const trimmed = inner.trim();
    return trimmed === '' ? null : trimmed;
  }
  return null;
}

/**
 * Tira a ênfase de um VALOR — e SÓ quando ela veste o valor INTEIRO.
 *
 * O CONTRATO, escrito aqui porque a versão anterior tinha um comentário
 * descrevendo uma regra que o código não cumpria e que nenhum teste tocava:
 *
 *  1. Um par ABRE+FECHA envolvendo o valor todo cai, e só ele:
 *     `**x**` → `x`, `` `x` `` → `x`, `_x_` → `x`, `***x***` → `x`.
 *  2. QUALQUER OUTRA COISA VOLTA BYTE A BYTE (só o branco das bordas sai, que
 *     nunca é conteúdo). Em particular um caminho entre crases NO MEIO da
 *     frase sobrevive inteiro — e essa é a forma que os dois prompts do debate
 *     MAIS produzem, porque ambos mandam CITAR UM CAMINHO em `Por quê` e em
 *     `Evidência`:
 *         `` `.huu/dev/epoch-1/atlas.md` separa api de cli ``
 *     volta com as DUAS crases. A versão anterior comia só a de abertura e
 *     devolvia uma crase órfã, com `parsed: true` e zero warnings.
 *  3. Um par cujo FECHA não é o fim do valor não é um par: em `**A** ou **B**`
 *     o `**` inicial fecha no índice 3, então nada sai — descascar produziria
 *     o `A** ou **B` corrompido. Idem `*estender* o schema`.
 *  4. O marcador que o RÓTULO deixou para trás (`- **Escolhido:** x`, com o
 *     dois-pontos DENTRO do negrito) não é ênfase do valor: ele cai antes, em
 *     {@link dropLabelCloser}, onde ainda se sabe de quem o marcador é.
 */
function stripValueEmphasis(value: string): string {
  let out = value.trim();
  // Ninho de marcadores (`***x***`) sai em camadas; o teto existe porque
  // `while (true)` sobre texto de LLM é uma promessa que não se cumpre.
  for (let round = 0; round < 4; round++) {
    const peeled = peelEmphasisPair(out);
    if (peeled === null) return out;
    out = peeled;
  }
  return out;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * `clamp` que CONTA o que cortou. Todo teto deste módulo passa por aqui ou por
 * uma flag equivalente: a doc promete "excedente é truncado, nunca descartado",
 * e truncar em silêncio é a metade da promessa que ninguém consegue auditar.
 */
function clampWarn(warnings: string[], text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  pushWarning(warnings, `${what} truncado em ${max} caracteres`);
  return clamp(text, max);
}

function pushWarning(warnings: string[], message: string): void {
  if (warnings.length >= MAX_WARNINGS) return;
  if (warnings.length === MAX_WARNINGS - 1) {
    warnings.push('mais avisos foram suprimidos (teto de warnings atingido)');
    return;
  }
  warnings.push(message);
}

interface Heading {
  level: number;
  text: string;
}

/**
 * Heading tolerante: até 3 espaços de indentação, 1..8 `#` (o modelo erra o
 * nível para mais e para menos), espaço depois do `#` opcional, `#` de
 * fechamento descartados.
 */
function parseHeading(line: string): Heading | null {
  let i = 0;
  while (i < 3 && (line[i] === ' ' || line[i] === '\t')) i++;
  let hashes = 0;
  while (hashes < 9 && line[i + hashes] === '#') hashes++;
  if (hashes === 0 || hashes > 8) return null;
  const text = trimTrailingHashes(line.slice(i + hashes)).trim();
  return { level: hashes, text };
}

interface DecisionIdMatch {
  id: string;
  rest: string;
}

/** `D1`, `d 2`, `**D10**`, `D3.` → id normalizado + o que sobra da linha. */
function parseDecisionId(text: string): DecisionIdMatch | null {
  const m = DECISION_ID.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length).replace(LEADING_SEPARATORS, '').trim();
  return { id: `D${Number(m[1])}`, rest };
}

interface FieldLine {
  label: string;
  value: string;
  /** O valor bateu num teto e foi CORTADO — o chamador vira isto em warning. */
  truncated: boolean;
}

/** Máximo de caracteres antes do `:` para uma linha ainda ser um CAMPO. */
const LABEL_MAX_CHARS = 80;

/** Quanto o marcador de bullet ocupa no começo da linha (0 quando não há). */
function bulletPrefixLength(line: string): number {
  const m = BULLET.exec(line);
  return m === null ? 0 : m[0].length;
}

/** O run de `*`/`_`/`` ` `` que ABRE um rótulo (`**Escolhido` → `**`). */
function leadingMarkerRun(text: string): string {
  let i = 0;
  while (i < text.length && (text[i] === '*' || text[i] === '_' || text[i] === '`')) i++;
  return text.slice(0, i);
}

/**
 * O `**` logo depois do `:` em `- **Escolhido:** x` é o FECHO DO RÓTULO, não
 * ênfase do valor: o rótulo abriu um marcador e não o fechou antes dos
 * dois-pontos. Aqui — onde ainda se sabe de quem o marcador é — ele cai.
 * Quando o rótulo JÁ fechou (`- **Escolhido**: **x**`), o marcador do valor é
 * do valor, e quem decide é {@link stripValueEmphasis}.
 */
function dropLabelCloser(rawLabel: string, tail: string): string {
  const opener = leadingMarkerRun(rawLabel);
  if (opener === '') return tail;
  if (rawLabel.length > opener.length && rawLabel.endsWith(opener)) return tail;
  return tail.startsWith(opener) ? tail.slice(opener.length) : tail;
}

/**
 * `- **Escolhido:** x`, `- **Escolhido**: x`, `* Escolhido : x`, `Escolhido: x`.
 *
 * O rótulo tem que caber em {@link LABEL_MAX_CHARS} caracteres antes dos
 * dois-pontos — uma frase inteira com um `:` no meio não é um campo. Só essa
 * janela é varrida atrás do `:`, então o casamento custa O(1) por linha, por
 * maior que a linha seja.
 *
 * LINHA LONGA NÃO É LINHA PERDIDA. Até {@link MAX_LINE_CHARS} da linha são
 * interpretados e o valor é cortado em {@link MAX_FIELD_CHARS}; sai
 * `truncated: true`, que o chamador vira warning. A versão anterior devolvia
 * `null` aqui e, como um campo é sempre um bullet, o chamador jogava a linha
 * INTEIRA fora: um `Escolhido` de 4 001 caracteres virava `null`, com
 * `parsed: true` e sem um aviso sequer — o oposto do que a doc de
 * {@link MAX_FIELD_CHARS} promete.
 */
function parseFieldLine(line: string): FieldLine | null {
  const overlong = line.length > MAX_LINE_CHARS;
  const scanned = overlong ? clamp(line, MAX_LINE_CHARS) : line;
  let start = bulletPrefixLength(scanned);
  while (start < scanned.length && isSpace(scanned[start]!)) start++;
  const labelWindow = scanned.slice(start, start + LABEL_MAX_CHARS + 1);
  const colon = labelWindow.indexOf(':');
  if (colon <= 0) return null;
  const rawLabel = labelWindow.slice(0, colon);
  const label = normalizeLabel(rawLabel);
  if (!label) return null;
  const tail = scanned.slice(start + colon + 1);
  return {
    label,
    value: stripValueEmphasis(clamp(dropLabelCloser(rawLabel, tail), MAX_FIELD_CHARS)),
    truncated: overlong || tail.length > MAX_FIELD_CHARS,
  };
}

function isBullet(line: string): boolean {
  return BULLET.test(line);
}

function bulletBody(line: string): string {
  return line.replace(BULLET, '').trim();
}

/** Classifica um heading de SEÇÃO. Ids de decisão são tratados antes disto. */
function classifySection(headingText: string): DebateSectionId | null {
  const n = normalizeLabel(headingText);
  if (n.startsWith('decis')) return 'decisoes';
  if (n.startsWith('risco')) return 'riscos';
  if (n.startsWith('veredito')) return 'veredito';
  if (n.startsWith('objec')) return 'objecoes';
  return null;
}

/** Quebra em linhas com teto, normalizando CRLF e CR. */
function toLines(raw: string): { lines: string[]; overflow: boolean } {
  const all = raw.replace(/\r\n?/g, '\n').split('\n');
  if (all.length <= MAX_BRIEF_LINES) return { lines: all, overflow: false };
  return { lines: all.slice(0, MAX_BRIEF_LINES), overflow: true };
}

/** Dobra uma continuação no campo. Corta no teto e DIZ que cortou. */
function appendField(
  current: string | null,
  addition: string,
): { text: string; truncated: boolean } {
  const next = current === null || current === '' ? addition : `${current}\n${addition}`;
  return { text: clamp(next, MAX_FIELD_CHARS), truncated: next.length > MAX_FIELD_CHARS };
}

function sectionReport(
  id: DebateSectionId,
  found: boolean,
  entries: number,
  expected: boolean,
): DebateSectionReport {
  return { id, found, entries, expected };
}

/**
 * Uma seção "bateu" quando o heading apareceu E, para as seções que carregam o
 * conteúdo principal, saiu pelo menos uma entrada. Um `## Decisões` vazio é um
 * brief quebrado, não um brief curto.
 */
function matched(report: DebateSectionReport, requiresEntries: boolean): boolean {
  if (!report.found) return false;
  return requiresEntries ? report.entries > 0 : true;
}

// ────────────────────────────── parser de A ─────────────────────────────────

const A_FIELD_LABELS: Record<string, 'escolhido' | 'rejeitado' | 'porQue' | 'falsificaria'> = {
  escolhido: 'escolhido',
  escolha: 'escolhido',
  rejeitado: 'rejeitado',
  rejeitada: 'rejeitado',
  'alternativa rejeitada': 'rejeitado',
  'por que': 'porQue',
  porque: 'porQue',
  motivo: 'porQue',
  razao: 'porQue',
  falsificaria: 'falsificaria',
  'o que falsificaria': 'falsificaria',
};

interface MutableDecision extends DebateDecision {
  startLine: number;
  endLine: number;
}

/**
 * Lê `A.md`. NUNCA lança: qualquer entrada devolve um {@link DebateBriefA}
 * válido com o cru dentro.
 */
export function parseDebateBriefA(input: string | null | undefined): DebateBriefA {
  const source = typeof input === 'string' ? input : '';
  const truncated = source.length > MAX_BRIEF_CHARS;
  const raw = truncated ? source.slice(0, MAX_BRIEF_CHARS) : source;
  const warnings: string[] = [];
  if (truncated) pushWarning(warnings, `brief A cortado em ${MAX_BRIEF_CHARS} caracteres`);

  const decisions: MutableDecision[] = [];
  const risks: DebateRisk[] = [];
  let foundDecisoes = false;
  let foundRiscos = false;

  const present = raw.trim().length > 0;
  if (present) {
    const { lines, overflow } = toLines(raw);
    if (overflow) pushWarning(warnings, `apenas as primeiras ${MAX_BRIEF_LINES} linhas foram lidas`);

    let section: DebateSectionId | null = null;
    let decision: MutableDecision | null = null;
    let field: 'escolhido' | 'rejeitado' | 'porQue' | 'falsificaria' | null = null;
    let riskIndex = -1;
    let decisionsCapped = false;

    const closeDecision = (endLine: number): void => {
      if (decision) decision.endLine = endLine;
      decision = null;
      field = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const heading = parseHeading(line);

      if (heading) {
        const id = parseDecisionId(heading.text);
        if (id) {
          closeDecision(i);
          riskIndex = -1;
          if (decisions.length >= MAX_DECISIONS) {
            if (!decisionsCapped) {
              decisionsCapped = true;
              pushWarning(warnings, `mais de ${MAX_DECISIONS} decisões — o excedente foi ignorado`);
            }
            continue;
          }
          if (section !== 'decisoes') {
            pushWarning(warnings, `decisão ${id.id} apareceu fora de "## Decisões"`);
          }
          const next: MutableDecision = {
            id: id.id,
            title: clampWarn(warnings, id.rest, MAX_TITLE_CHARS, `título de ${id.id}`),
            escolhido: null,
            rejeitado: null,
            porQue: null,
            falsificaria: null,
            raw: '',
            startLine: i,
            endLine: lines.length,
          };
          decisions.push(next);
          decision = next;
          continue;
        }

        const classified = classifySection(heading.text);
        if (classified === null) {
          // Heading extra no meio do brief: não derruba a decisão aberta (o
          // modelo intercala "### Contexto" e segue listando os campos), só
          // fecha o campo em curso.
          field = null;
          pushWarning(warnings, `heading não reconhecido: "${clamp(heading.text, 80)}"`);
          continue;
        }
        closeDecision(i);
        riskIndex = -1;
        section = classified;
        if (classified === 'decisoes') foundDecisoes = true;
        if (classified === 'riscos') foundRiscos = true;
        continue;
      }

      if (decision) {
        const open = decision;
        const parsedField = parseFieldLine(line);
        const mapped = parsedField ? A_FIELD_LABELS[parsedField.label] : undefined;
        if (parsedField && mapped) {
          open[mapped] = clamp(parsedField.value, MAX_FIELD_CHARS);
          if (parsedField.truncated) {
            pushWarning(
              warnings,
              `campo "${parsedField.label}" de ${open.id} truncado em ${MAX_FIELD_CHARS} caracteres`,
            );
          }
          field = mapped;
          continue;
        }
        // Um BULLET nunca é continuação: é outro item. É o que impede um
        // `- **Rejei` truncado no fim do arquivo de virar sufixo do
        // `Escolhido:` anterior, e um bullet de rótulo desconhecido de
        // contaminar o último campo reconhecido.
        if (isBullet(line)) {
          field = null;
          continue;
        }
        const trimmed = line.trim();
        if (trimmed === '') {
          field = null;
          continue;
        }
        // Valor de várias linhas: o modelo quebra a frase e a continuação não
        // tem rótulo nenhum.
        if (field) {
          const folded = appendField(open[field], trimmed);
          open[field] = folded.text;
          if (folded.truncated) {
            pushWarning(
              warnings,
              `campo "${field}" de ${open.id} truncado em ${MAX_FIELD_CHARS} caracteres`,
            );
          }
        }
        continue;
      }

      if (section === 'riscos') {
        if (isBullet(line)) {
          if (risks.length >= MAX_RISKS) continue;
          risks.push({ text: clampWarn(warnings, bulletBody(line), MAX_FIELD_CHARS, 'risco') });
          riskIndex = risks.length - 1;
          continue;
        }
        const trimmed = line.trim();
        if (trimmed === '') {
          riskIndex = -1;
          continue;
        }
        if (riskIndex >= 0) {
          const target = risks[riskIndex]!;
          const folded = appendField(target.text, trimmed);
          target.text = folded.text;
          if (folded.truncated) {
            pushWarning(warnings, `risco truncado em ${MAX_FIELD_CHARS} caracteres`);
          }
          continue;
        }
        // Seção de riscos escrita como prosa, sem bullet nenhum.
        if (risks.length >= MAX_RISKS) continue;
        risks.push({ text: clampWarn(warnings, trimmed, MAX_FIELD_CHARS, 'risco') });
        riskIndex = risks.length - 1;
        continue;
      }
    }

    for (const d of decisions) {
      d.raw = lines.slice(d.startLine, d.endLine).join('\n').trimEnd();
    }
  }

  const reports = [
    sectionReport('decisoes', foundDecisoes, decisions.length, true),
    sectionReport('riscos', foundRiscos, risks.length, true),
  ];
  const missingSections: DebateSectionId[] = [];
  if (!matched(reports[0]!, true)) missingSections.push('decisoes');
  if (!matched(reports[1]!, false)) missingSections.push('riscos');

  const seen = new Set<string>();
  for (const d of decisions) {
    if (seen.has(d.id)) pushWarning(warnings, `decisão ${d.id} declarada mais de uma vez`);
    seen.add(d.id);
  }

  return {
    side: 'A',
    raw,
    present,
    truncated,
    decisions: decisions.map(stripCursor),
    risks,
    sections: reports,
    missingSections,
    parsed: present && missingSections.length === 0,
    warnings,
  };
}

function stripCursor(d: MutableDecision): DebateDecision {
  const { startLine: _s, endLine: _e, ...rest } = d;
  return rest;
}

// ────────────────────────────── parser de B ─────────────────────────────────

const B_FIELD_LABELS: Record<
  string,
  'falhaPrevista' | 'evidencia' | 'alternativaMaisBarata'
> = {
  'falha prevista': 'falhaPrevista',
  falha: 'falhaPrevista',
  'falha esperada': 'falhaPrevista',
  evidencia: 'evidencia',
  evidencias: 'evidencia',
  prova: 'evidencia',
  'alternativa mais barata': 'alternativaMaisBarata',
  alternativa: 'alternativaMaisBarata',
  'alternativa mais simples': 'alternativaMaisBarata',
};

/** `SUSTENTADA`/`sustentado`/`Contestada` → o rótulo canônico. */
function classifyVerdictLabel(word: string): DebateVerdictLabel | null {
  const n = normalizeLabel(word);
  if (n.startsWith('sustenta')) return 'SUSTENTADA';
  if (n.startsWith('contesta')) return 'CONTESTADA';
  return null;
}

interface VerdictParse {
  label: DebateVerdictLabel | null;
  reason: string;
}

/**
 * Do texto depois do id: rótulo + justificativa, com `—`/`-`/`–`/`:` como
 * separador. Não corta nada — quem corta é o chamador, que tem a lista de
 * warnings na mão e portanto consegue DIZER que cortou.
 */
function parseVerdictTail(tail: string): VerdictParse {
  const m = /^[\p{L}]{1,24}/u.exec(tail);
  const label = m ? classifyVerdictLabel(m[0]) : null;
  if (!label) return { label: null, reason: tail.trim() };
  const rest = tail.slice(m![0].length).replace(LEADING_SEPARATORS, '').trim();
  return { label, reason: rest };
}

interface MutableObjection extends DebateObjection {
  startLine: number;
  endLine: number;
}

/**
 * Lê `B.md`. NUNCA lança — mesmas garantias de {@link parseDebateBriefA}.
 */
export function parseDebateBriefB(input: string | null | undefined): DebateBriefB {
  const source = typeof input === 'string' ? input : '';
  const truncated = source.length > MAX_BRIEF_CHARS;
  const raw = truncated ? source.slice(0, MAX_BRIEF_CHARS) : source;
  const warnings: string[] = [];
  if (truncated) pushWarning(warnings, `brief B cortado em ${MAX_BRIEF_CHARS} caracteres`);

  const verdicts: DebateVerdict[] = [];
  const objections: MutableObjection[] = [];
  let foundVeredito = false;
  let foundObjecoes = false;

  const present = raw.trim().length > 0;
  if (present) {
    const { lines, overflow } = toLines(raw);
    if (overflow) pushWarning(warnings, `apenas as primeiras ${MAX_BRIEF_LINES} linhas foram lidas`);

    let section: DebateSectionId | null = null;
    let objection: MutableObjection | null = null;
    let field: 'falhaPrevista' | 'evidencia' | 'alternativaMaisBarata' | null = null;
    const seenVerdicts = new Set<string>();
    let verdictsCapped = false;
    let objectionsCapped = false;

    const closeObjection = (endLine: number): void => {
      if (objection) objection.endLine = endLine;
      objection = null;
      field = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const heading = parseHeading(line);

      if (heading) {
        const id = parseDecisionId(heading.text);
        if (id) {
          // Em `B.md` o único item com heading é uma OBJEÇÃO: os vereditos são
          // bullets. Um `### D2` fora de "## Objeções" ainda é lido como
          // objeção, com aviso.
          closeObjection(i);
          if (objections.length >= MAX_OBJECTIONS) {
            if (!objectionsCapped) {
              objectionsCapped = true;
              pushWarning(warnings, `mais de ${MAX_OBJECTIONS} objeções — o excedente foi ignorado`);
            }
            continue;
          }
          if (section !== 'objecoes') {
            pushWarning(warnings, `objeção ${id.id} apareceu fora de "## Objeções"`);
          }
          const next: MutableObjection = {
            decisionId: id.id,
            falhaPrevista: null,
            evidencia: null,
            alternativaMaisBarata: null,
            raw: '',
            startLine: i,
            endLine: lines.length,
          };
          objections.push(next);
          objection = next;
          continue;
        }

        const classified = classifySection(heading.text);
        if (classified === null) {
          field = null;
          pushWarning(warnings, `heading não reconhecido: "${clamp(heading.text, 80)}"`);
          continue;
        }
        closeObjection(i);
        section = classified;
        if (classified === 'veredito') foundVeredito = true;
        if (classified === 'objecoes') foundObjecoes = true;
        continue;
      }

      if (objection) {
        const open = objection;
        const parsedField = parseFieldLine(line);
        const mapped = parsedField ? B_FIELD_LABELS[parsedField.label] : undefined;
        if (parsedField && mapped) {
          open[mapped] = clamp(parsedField.value, MAX_FIELD_CHARS);
          if (parsedField.truncated) {
            pushWarning(
              warnings,
              `campo "${parsedField.label}" de ${open.decisionId} truncado em ${MAX_FIELD_CHARS} caracteres`,
            );
          }
          field = mapped;
          continue;
        }
        // Mesma regra do brief A: bullet é item novo, nunca continuação.
        if (isBullet(line)) {
          field = null;
          continue;
        }
        const trimmed = line.trim();
        if (trimmed === '') {
          field = null;
          continue;
        }
        if (field) {
          const folded = appendField(open[field], trimmed);
          open[field] = folded.text;
          if (folded.truncated) {
            pushWarning(
              warnings,
              `campo "${field}" de ${open.decisionId} truncado em ${MAX_FIELD_CHARS} caracteres`,
            );
          }
        }
        continue;
      }

      // Vereditos: bullets dentro de "## Veredito por decisão". Fora de
      // qualquer seção conhecida a linha só conta se trouxer um rótulo — sem
      // isso, qualquer frase começando com "D" viraria veredito.
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (section !== 'veredito' && section !== null) continue;
      const body = isBullet(line) ? bulletBody(line) : trimmed;
      const id = parseDecisionId(body);
      if (!id) continue;
      const tail = parseVerdictTail(id.rest);
      if (section === null && tail.label === null) continue;
      if (verdicts.length >= MAX_VERDICTS) {
        if (!verdictsCapped) {
          verdictsCapped = true;
          pushWarning(warnings, `mais de ${MAX_VERDICTS} vereditos — o excedente foi ignorado`);
        }
        continue;
      }
      if (seenVerdicts.has(id.id)) {
        pushWarning(warnings, `veredito de ${id.id} declarado mais de uma vez`);
      }
      seenVerdicts.add(id.id);
      if (tail.label === null) {
        pushWarning(warnings, `veredito de ${id.id} sem SUSTENTADA/CONTESTADA legível`);
      }
      verdicts.push({
        decisionId: id.id,
        label: tail.label,
        reason: clampWarn(warnings, tail.reason, MAX_FIELD_CHARS, `veredito de ${id.id}`),
        raw: clampWarn(warnings, trimmed, MAX_FIELD_CHARS, `linha do veredito de ${id.id}`),
      });
    }

    for (const o of objections) {
      o.raw = lines.slice(o.startLine, o.endLine).join('\n').trimEnd();
    }
  }

  const contested = verdicts.filter((v) => v.label === 'CONTESTADA').length;
  const reports = [
    sectionReport('veredito', foundVeredito, verdicts.length, true),
    sectionReport('objecoes', foundObjecoes, objections.length, contested > 0),
  ];
  const missingSections: DebateSectionId[] = [];
  if (!matched(reports[0]!, true)) missingSections.push('veredito');
  if (reports[1]!.expected && !matched(reports[1]!, true)) missingSections.push('objecoes');

  return {
    side: 'B',
    raw,
    present,
    truncated,
    verdicts,
    objections: objections.map(stripObjectionCursor),
    sections: reports,
    missingSections,
    parsed: present && missingSections.length === 0,
    warnings,
  };
}

function stripObjectionCursor(o: MutableObjection): DebateObjection {
  const { startLine: _s, endLine: _e, ...rest } = o;
  return rest;
}

// ──────────────────────────── o transcript ──────────────────────────────────

/**
 * Junta os dois briefs na conversa que as UIs renderizam. NUNCA lança — se um
 * lado (ou os dois) não existir, o transcript sai com o brief ausente marcado
 * `present: false` e `parsed: false`, e os turnos vêm do lado que existe.
 */
export function buildDebateTranscript(input: {
  a?: string | null;
  b?: string | null;
}): DebateTranscript {
  const advocate = parseDebateBriefA(input?.a);
  const prosecutor = parseDebateBriefB(input?.b);

  const verdictById = new Map<string, DebateVerdict>();
  for (const v of prosecutor.verdicts) {
    if (!verdictById.has(v.decisionId)) verdictById.set(v.decisionId, v);
  }
  const objectionById = new Map<string, DebateObjection>();
  for (const o of prosecutor.objections) {
    if (!objectionById.has(o.decisionId)) objectionById.set(o.decisionId, o);
  }

  const exchanges: DebateExchange[] = [];
  const unjudgedDecisionIds: string[] = [];
  const declared = new Set<string>();

  for (const decision of advocate.decisions) {
    // Id repetido: vale a PRIMEIRA declaração. A segunda não some calada — ela
    // já rendeu um warning em `advocate.warnings` no parse, e continua no
    // `raw` do brief; aqui ela só não vira um segundo turno com o mesmo id.
    if (declared.has(decision.id)) continue;
    declared.add(decision.id);
    const verdict = verdictById.get(decision.id) ?? null;
    if (!verdict) unjudgedDecisionIds.push(decision.id);
    exchanges.push({
      decisionId: decision.id,
      decision,
      verdict,
      objection: objectionById.get(decision.id) ?? null,
    });
  }

  const orphanVerdictIds: string[] = [];
  for (const v of prosecutor.verdicts) {
    if (declared.has(v.decisionId)) continue;
    declared.add(v.decisionId);
    orphanVerdictIds.push(v.decisionId);
    exchanges.push({
      decisionId: v.decisionId,
      decision: null,
      verdict: v,
      objection: objectionById.get(v.decisionId) ?? null,
    });
  }

  // Deduplicado como os dois irmãos acima: B pode julgar `D1` duas vezes (com
  // warning), e um `['D1', 'D1']` aqui viraria dois badges do mesmo id na UI.
  const contestedDecisionIds: string[] = [];
  const contested = new Set<string>();
  for (const v of prosecutor.verdicts) {
    if (v.label !== 'CONTESTADA' || contested.has(v.decisionId)) continue;
    contested.add(v.decisionId);
    contestedDecisionIds.push(v.decisionId);
  }

  return {
    format: DEBATE_TRANSCRIPT_FORMAT,
    advocate,
    prosecutor,
    exchanges,
    unjudgedDecisionIds,
    orphanVerdictIds,
    contestedDecisionIds,
    parsed: advocate.parsed && prosecutor.parsed,
  };
}

// ─────────────────── onde o debate está no pipeline ─────────────────────────
//
// FRAGILIDADE DECLARADA: a âncora primária é o NOME DO PASSO, e os nomes são
// literais privados de `plan-to-pipeline.ts` (`advocateStepName()`,
// `prosecutorStepName()`, `debateCheckStepName()`) — não há id, tag nem campo
// de papel no `PipelineStep`. Renomear um passo lá quebra este localizador em
// silêncio: o debate simplesmente some da UI, sem erro nenhum. Quem renomear
// tem que atualizar as três constantes abaixo E os testes que as fixam.
//
// Por isso existe uma SEGUNDA âncora, estrutural, usada quando o nome não
// bate: os dois passos de trabalho do debate são os únicos que declaram
// `writes: ['<epoch>/debate/**']`, o promotor é o que `dependsOn` o advogado, e
// o portão é um check que declara OS DOIS rótulos `convergiu`/`contestado` —
// preferindo, quando há mais de um candidato, o que também `dependsOn` o
// promotor. Os rótulos são exigidos nos dois braços: um check achado só por
// `dependsOn` seria qualquer portão que rodasse depois do promotor, e apontar
// a UI do debate para o portão errado é pior do que não achar o debate.
// (O comentário dizia "ou os rótulos" e o código sempre exigiu os dois — era o
// comentário que estava errado, não `isDebateGate`.)
// Estrutura sobrevive a um rename; nome sobrevive a uma reordenação. Exigir as
// duas seria frágil ao quadrado.

/** Nome do passo do advogado, como `plan-to-pipeline.ts` o emite. */
export const DEBATE_ADVOCATE_STEP_NAME = 'Sustentar as escolhas';

/** Nome do passo do promotor. */
export const DEBATE_PROSECUTOR_STEP_NAME = 'Contestar as escolhas';

/** Nome do portão (o único nó do debate que roteia). */
export const DEBATE_GATE_STEP_NAME = 'Debate resolvido?';

/** Rótulo do arco para a frente do portão (é o `default`). */
export const DEBATE_OUTCOME_CONVERGED = 'convergiu';

/** Rótulo do arco que devolve o debate ao advogado. */
export const DEBATE_OUTCOME_CONTESTED = 'contestado';

/** Sufixo do glob que os dois passos do debate declaram em `writes`. */
const DEBATE_WRITES_SUFFIX = '/debate/**';

/** Papel de um passo dentro do bloco do debate. */
export type DebateRole = 'advocate' | 'prosecutor' | 'gate';

/** Os três passos do debate dentro de um pipeline compilado. */
export interface DebatePipelineSteps {
  advocate: WorkStep;
  prosecutor: WorkStep;
  gate: CheckStep;
  /** Os nomes, para quem só carrega nome (cards, frames SSE, logs de agente). */
  names: { advocate: string; prosecutor: string; gate: string };
  /** Caminhos dos dois briefs, quando dedutíveis do passo compilado. */
  briefPaths: { a: string; b: string } | null;
  /** Como os três foram achados — `name` (exato) ou `structure` (fallback). */
  matchedBy: 'name' | 'structure';
}

function steps(pipeline: Pipeline | null | undefined): PipelineStep[] {
  return pipeline && Array.isArray(pipeline.steps) ? pipeline.steps : [];
}

function dependsOn(step: PipelineStep, name: string): boolean {
  return Array.isArray(step.dependsOn) && step.dependsOn.includes(name);
}

function debateWrites(step: WorkStep): string | null {
  if (!Array.isArray(step.writes)) return null;
  for (const glob of step.writes) {
    if (typeof glob === 'string' && glob.endsWith(DEBATE_WRITES_SUFFIX)) return glob;
  }
  return null;
}

/** `.huu/dev/epoch-1/debate/**` → os dois briefs. `null` quando não dá para deduzir. */
function briefPathsOf(advocate: WorkStep): { a: string; b: string } | null {
  const glob = debateWrites(advocate);
  if (glob) {
    const dir = glob.slice(0, glob.length - DEBATE_WRITES_SUFFIX.length) + '/debate';
    return { a: `${dir}/A.md`, b: `${dir}/B.md` };
  }
  // Último recurso: o prompt do advogado cita `…/A.md` entre crases.
  const m = /`([^`\n]{1,300}\/A\.md)`/.exec(typeof advocate.prompt === 'string' ? advocate.prompt : '');
  if (!m) return null;
  const a = m[1]!;
  return { a, b: `${a.slice(0, a.length - 'A.md'.length)}B.md` };
}

function isDebateGate(step: PipelineStep): step is CheckStep {
  if (!isCheckStep(step)) return false;
  if (!Array.isArray(step.outcomes)) return false;
  const labels = step.outcomes.map((o) => o?.label);
  return labels.includes(DEBATE_OUTCOME_CONVERGED) && labels.includes(DEBATE_OUTCOME_CONTESTED);
}

/**
 * Onde está o debate neste pipeline — ou `null` quando ele está DESLIGADO, que
 * é o caso padrão (`--debate` vem desligado, e um pipeline sem debate é a
 * imensa maioria).
 *
 * Função pura: não lê arquivo, não toca git, não muta o pipeline. Devolve
 * `null` também quando só uma parte do bloco é identificável — meio debate não
 * é algo que a UI consiga renderizar como conversa, e inventar o resto seria
 * mostrar um lado que não existe.
 */
export function findDebateSteps(pipeline: Pipeline | null | undefined): DebatePipelineSteps | null {
  const all = steps(pipeline);
  if (all.length === 0) return null;

  const byName = (name: string): PipelineStep | undefined => all.find((s) => s?.name === name);

  const namedAdvocate = byName(DEBATE_ADVOCATE_STEP_NAME);
  const namedProsecutor = byName(DEBATE_PROSECUTOR_STEP_NAME);
  const namedGate = byName(DEBATE_GATE_STEP_NAME);
  if (
    namedAdvocate &&
    namedProsecutor &&
    namedGate &&
    isWorkStep(namedAdvocate) &&
    isWorkStep(namedProsecutor) &&
    isCheckStep(namedGate)
  ) {
    return assemble(namedAdvocate, namedProsecutor, namedGate, 'name');
  }

  // Fallback estrutural — sobrevive a um rename dos três passos.
  const work = all.filter(isWorkStep).filter((s) => debateWrites(s) !== null);
  if (work.length !== 2) return null;
  const [first, second] = work as [WorkStep, WorkStep];
  const advocate = dependsOn(second, first.name) ? first : dependsOn(first, second.name) ? second : first;
  const prosecutor = advocate === first ? second : first;
  const gate = all.find((s) => isDebateGate(s) && dependsOn(s, prosecutor.name)) ?? all.find(isDebateGate);
  if (!gate || !isCheckStep(gate)) return null;
  return assemble(advocate, prosecutor, gate, 'structure');
}

function assemble(
  advocate: WorkStep,
  prosecutor: WorkStep,
  gate: CheckStep,
  matchedBy: 'name' | 'structure',
): DebatePipelineSteps {
  return {
    advocate,
    prosecutor,
    gate,
    names: { advocate: advocate.name, prosecutor: prosecutor.name, gate: gate.name },
    briefPaths: briefPathsOf(advocate),
    matchedBy,
  };
}

/**
 * O papel de UM passo, por nome — o que a UI usa para saber de que lado um
 * agente pertence quando só tem o nome do card. `null` para qualquer passo que
 * não seja do debate (ou quando o debate está desligado).
 */
export function debateRoleOfStep(
  pipeline: Pipeline | null | undefined,
  stepName: string | null | undefined,
): DebateRole | null {
  if (typeof stepName !== 'string' || stepName === '') return null;
  const found = findDebateSteps(pipeline);
  if (!found) return null;
  if (found.names.advocate === stepName) return 'advocate';
  if (found.names.prosecutor === stepName) return 'prosecutor';
  if (found.names.gate === stepName) return 'gate';
  return null;
}

/** `true` quando este pipeline compilou o bloco do debate. */
export function hasDebate(pipeline: Pipeline | null | undefined): boolean {
  return findDebateSteps(pipeline) !== null;
}
