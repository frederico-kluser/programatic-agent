#!/usr/bin/env npx tsx
/**
 * check-metodo.ts — Deriva números do §1 e §3 do METODO.md do repositório
 * real e compara com os valores escritos no documento.
 *
 * Se a prosa discordar, imprime o valor correto e sai != 0.
 * Um cabeçalho stale (commit diferente de HEAD) é pior que nenhum.
 *
 * M9-01 — Estado derivado + catálogo de falso-verde vivo.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const METODO_PATH = resolve(ROOT, 'METODO.md');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sh(cmd: string): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function shNum(cmd: string): number {
  return parseInt(sh(cmd), 10) || 0;
}

function fileLines(relPath: string): number {
  try {
    const content = readFileSync(resolve(ROOT, relPath), 'utf8');
    // Match wc -l: count newline characters
    return content.endsWith('\n')
      ? content.split('\n').length - 1
      : content.split('\n').length;
  } catch {
    return -1;
  }
}

/** Parse a pt-BR number string like "135.866" → 135866 or "0,57" → 0.57 */
function parsePtBr(s: string): number {
  const cleaned = s.replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

/** Find a markdown table row containing the label, and extract the first
 *  bold number from it. Returns [rawString, numericValue] or null. */
function findNumberInRow(section: string, label: string): [string, number] | null {
  // Find a table row (line starting with |) that contains the label
  const lines = section.split('\n');
  const row = lines.find(
    (l) => l.startsWith('|') && l.includes(label),
  );
  if (!row) return null;
  // Find the first bold span with a digit in this row
  const boldRe = /\*\*([^*]*[\d][^*]*)\*\*/;
  const bm = row.match(boldRe);
  if (!bm) return null;
  const numMatch = bm[1].match(/[\d.]+(?:,\d+)?/);
  if (!numMatch) return null;
  return [numMatch[0], parsePtBr(numMatch[0])];
}

/** Find a table row containing the label and extract ALL bold numbers from it. */
function findAllNumbersInRow(section: string, label: string): [string, number][] {
  const lines = section.split('\n');
  const row = lines.find(
    (l) => l.startsWith('|') && l.includes(label),
  );
  if (!row) return [];
  const results: [string, number][] = [];
  const boldRe = /\*\*([^*]*[\d][^*]*)\*\*/g;
  let bm: RegExpExecArray | null;
  while ((bm = boldRe.exec(row)) !== null) {
    const numMatches = [...bm[1].matchAll(/[\d.]+(?:,\d+)?/g)];
    for (const nm of numMatches) results.push([nm[0], parsePtBr(nm[0])]);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Report a mismatch
// ---------------------------------------------------------------------------

const errors: string[] = [];
const warnings: string[] = [];

/**
 * Tolerância relativa de todo número derivado.
 *
 * Estes números descrevem a ESCALA do repositório, e **todo** commit os move.
 * Um gate de igualdade exata ficaria vermelho no commit seguinte a cada
 * atualização — que é exatamente como se ensina um time a ignorar o vermelho
 * (foi o que aconteceu com o `PENDENTE` do gate.sh). 10% pega prosa
 * materialmente errada — esta tabela ficou 23% fora entre 2026-07-30 e
 * 2026-08-01 — e sobrevive ao trabalho normal. Ajustável por
 * HUU_METODO_TOLERANCE.
 */
const TOLERANCE = Number(process.env.HUU_METODO_TOLERANCE ?? '0.10');

function withinTolerance(claimed: number, actual: number): boolean {
  if (claimed === actual) return true;
  return Math.abs(claimed - actual) / Math.max(Math.abs(actual), 1) <= TOLERANCE;
}

function driftPct(claimed: number, actual: number): string {
  const pct = (Math.abs(claimed - actual) / Math.max(Math.abs(actual), 1)) * 100;
  return `${pct.toFixed(1)}% fora`;
}

/**
 * Tolerância ABSOLUTA (±0,02) da razão teste:código — a ÚNICA entrada de §1
 * que não usa TOLERANCE (relativa). Exportada e testada isoladamente porque
 * comparação de ponto flutuante nesta fronteira é fácil de quebrar de volta.
 */
export const RATIO_ABS_TOLERANCE = 0.02;

/**
 * `claimed` vem de `parsePtBr("0,74")` (decimal exato) e `actual` de
 * `(testLines / codeLines).toFixed(2)` — ambos binários de ponto flutuante, e
 * a SUBTRAÇÃO de dois decimais exatamente representáveis não é, ela mesma,
 * exatamente representável: `0.74 - 0.72 === 0.020000000000000018`, não
 * `0.02`. Um `> RATIO_ABS_TOLERANCE` nu portanto REJEITA uma diferença que
 * está exatamente NA fronteira da tolerância — o único valor que a tolerância
 * existe para deixar passar. RATIO_EPSILON absorve só esse ruído de ponto
 * flutuante: é ~9 ordens de grandeza menor que a tolerância de 0.02, então não
 * consegue mascarar uma deriva real. NÃO "simplifique" isto de volta para
 * `Math.abs(claimed - actual) <= RATIO_ABS_TOLERANCE` — isso reintroduz a
 * falha no caso de fronteira exata (ver check-metodo.test.ts).
 */
const RATIO_EPSILON = 1e-9;

export function ratioWithinTolerance(claimed: number, actual: number): boolean {
  return Math.abs(claimed - actual) <= RATIO_ABS_TOLERANCE + RATIO_EPSILON;
}

function mismatch(
  what: string,
  claimed: string,
  actual: number,
  note?: string,
) {
  const suffix = note ? ` (${note})` : '';
  errors.push(
    `${what}: METODO.md afirma \`${claimed}\`, mas o valor real é \`${actual}\` ` +
      `— ${driftPct(parsePtBr(claimed), actual)}, acima da tolerância de ` +
      `${(TOLERANCE * 100).toFixed(0)}%${suffix}`,
  );
}

// ---------------------------------------------------------------------------
// §0 — Header check
// ---------------------------------------------------------------------------

function checkHeader(metodo: string) {
  const headCommit = sh('git rev-parse --short HEAD');

  // Find the "Data de escrita" line + commit
  const headerMatch = metodo.match(
    /Data de escrita:\s*\*\*([^*]+)\*\*[^`]*commit\s*`([a-f0-9]+)`/i,
  );
  if (!headerMatch) {
    errors.push(
      'HEADER: não foi possível extrair data e commit do cabeçalho do METODO.md',
    );
    return;
  }

  const [, docDate, docCommit] = headerMatch;

  if (docCommit !== headCommit) {
    // WARNING, nunca erro: um arquivo não pode conter o hash do commit que o
    // introduz, então "header == HEAD" é insatisfazível por construção — como
    // gate, ficaria vermelho no commit seguinte a toda atualização, para
    // sempre. Quem guarda a verdade aqui são os números abaixo, que SÃO
    // verificáveis contra a árvore de trabalho. (A CI também clona raso por
    // padrão, então validar o hash contra o histórico nem sempre é possível.)
    warnings.push(
      `HEADER: METODO.md foi medido no commit \`${docCommit}\` ` +
        `(data ${docDate}), mas HEAD é \`${headCommit}\` — reescreva o cabeçalho ` +
        `quando reescrever os números`,
    );
  } else {
    console.log(`HEADER OK: commit ${docCommit}, data ${docDate} (HEAD: ${headCommit})`);
  }
}

// ---------------------------------------------------------------------------
// §1 checks
// ---------------------------------------------------------------------------

/** Extract the section text between two top-level # § headings. */
function extractSection(metodo: string, sectionLabel: string): string {
  const heading = `# ${sectionLabel} `;
  const start = metodo.indexOf(heading);
  if (start === -1) return '';
  // Find end of the heading line
  const headingEnd = metodo.indexOf('\n', start);
  // Search for the NEXT # § heading after this heading's line
  const afterHeading = metodo.slice(headingEnd + 1);
  const nextMatch = afterHeading.search(/^# §/m);
  const end =
    nextMatch === -1 ? metodo.length : headingEnd + 1 + nextMatch;
  return metodo.slice(start, end);
}

function checkSecao1(metodo: string) {
  const section = extractSection(metodo, '§1');
  if (!section) {
    errors.push('§1: seção não encontrada no METODO.md');
    return;
  }

  // ---- 1. Total versionado ----
  {
    const claimed = findNumberInRow(section, 'Total versionado');
    const actual = shNum(
      `git ls-files | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'`,
    );
    if (claimed) {
      console.log(`§1 Total versionado: doc=${claimed[0]} real=${actual}`);
      if (!withinTolerance(claimed[1], actual))
        mismatch('§1 Total versionado', claimed[0], actual);
    } else {
      warnings.push('§1 Total versionado: número não encontrado no documento');
    }
  }

  // ---- 2. src/ TS+TSX não-teste ----
  {
    const claimed = findNumberInRow(section, 'não-teste');
    const actual = shNum(
      `find src \\( -name '*.ts' -o -name '*.tsx' \\) ! -name '*.test.ts' -exec cat {} + | wc -l`,
    );
    if (claimed) {
      console.log(`§1 TS+TSX não-teste: doc=${claimed[0]} real=${actual}`);
      if (!withinTolerance(claimed[1], actual))
        mismatch('§1 src/ TS+TSX não-teste', claimed[0], actual);
    } else {
      warnings.push('§1 TS+TSX não-teste: número não encontrado no documento');
    }
  }

  // ---- 3. Testes (arquivos, linhas, razão) ----
  {
    // Extract numbers from the "Testes |" table row
    const nums = findAllNumbersInRow(section, 'Testes');
    const testFiles = shNum(`find src -name '*.test.ts' | wc -l`);
    const testLines = shNum(
      `find src -name '*.test.ts' -exec cat {} + | wc -l`,
    );
    const codeLines = shNum(
      `find src \\( -name '*.ts' -o -name '*.tsx' \\) ! -name '*.test.ts' -exec cat {} + | wc -l`,
    );
    const ratio =
      codeLines > 0
        ? parseFloat((testLines / codeLines).toFixed(2))
        : 0;

    // nums[0] = file count, nums[1] = line count, nums[2] = ratio (0,57), nums[3] = 1 from ": 1"
    if (nums.length >= 1) {
      console.log(`§1 Testes (arquivos): doc=${nums[0][0]} real=${testFiles}`);
      if (!withinTolerance(nums[0][1], testFiles))
        mismatch('§1 Testes (arquivos)', nums[0][0], testFiles);
    } else {
      warnings.push('§1 Testes: contagem de arquivos não encontrada');
    }

    if (nums.length >= 2) {
      console.log(
        `§1 Testes (linhas): doc=${nums[1][0]} real=${testLines}`,
      );
      if (!withinTolerance(nums[1][1], testLines))
        mismatch('§1 Testes (linhas)', nums[1][0], testLines);
    } else {
      warnings.push('§1 Testes: contagem de linhas não encontrada');
    }

    // Ratio is the number with a comma (0,57); skip integer "1" from ": 1"
    const ratioNum = nums.find(([raw]) => raw.includes(','));
    if (ratioNum) {
      console.log(
        `§1 Testes (razão): doc=${ratioNum[0]} real=${ratio.toFixed(2)}`,
      );
      // Tolerância ABSOLUTA (±0.02), não relativa — ver ratioWithinTolerance()
      // acima para o porquê da comparação não ser um `> 0.02` nu.
      if (!ratioWithinTolerance(ratioNum[1], ratio))
        mismatch('§1 Testes (razão teste:código)', ratioNum[0], ratio);
    } else {
      warnings.push('§1 Testes: razão não encontrada');
    }
  }

  // ---- 4. Skills ----
  {
    const claimed = findNumberInRow(section, 'Skills');
    const actual = shNum(`find .agents/skills -name 'SKILL.md' | wc -l`);
    if (claimed) {
      console.log(`§1 Skills: doc=${claimed[0]} real=${actual}`);
      if (!withinTolerance(claimed[1], actual)) mismatch('§1 Skills', claimed[0], actual);
    } else {
      warnings.push('§1 Skills: número não encontrado no documento');
    }
  }

  // ---- 5. Arquivos em src/ ----
  {
    const claimed = findNumberInRow(section, '`src/`');
    // O documento diz, na própria linha, "inclui client JS/CSS/HTML" — então a
    // contagem correta é de TODOS os arquivos sob src/. Antes isto media só
    // TS+TSX e por isso emitia um WARN permanente: o verificador comparava
    // contra uma definição diferente da que o documento declara, e um aviso
    // que nunca sai é ruído que se aprende a ignorar.
    const actual = shNum(`find src -type f | wc -l`);
    if (claimed) {
      console.log(`§1 src/ (arquivos): doc=${claimed[0]} real=${actual}`);
      if (!withinTolerance(claimed[1], actual))
        mismatch('§1 src/ (arquivos)', claimed[0], actual);
    } else {
      warnings.push('§1 src/: número não encontrado no documento');
    }
  }
}

// ---------------------------------------------------------------------------
// §3 checks — singleton file line counts
// ---------------------------------------------------------------------------

interface SingletonRow {
  file: string;
  claimedLines: number;
}

function parseSecao3(metodo: string): SingletonRow[] {
  const section = extractSection(metodo, '§3');
  if (!section) return [];

  // Parse table rows: | `filepath` | N | ... |
  // The first number column is the line count with "." thousands separator.
  const rows: SingletonRow[] = [];
  // Match the full first cell (may contain multiple `file` + `file` entries)
  const tableRe = /^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(section)) !== null) {
    const cell = m[1].trim(); // e.g. "`src/web/client/app.js`" or "`README.md` + `README.en.md`"
    const numCol = m[2];     // e.g. "3.723" or "1.014 + 1.004"

    // Extract filenames from backtick-quoted strings
    const files: string[] = [];
    const fileRe = /`([^`]+)`/g;
    let fm: RegExpExecArray | null;
    while ((fm = fileRe.exec(cell)) !== null) {
      files.push(fm[1].trim());
    }

    // Extract all numbers from the number column
    const numMatches = [...numCol.matchAll(/[\d.]+/g)];
    const numbers = numMatches.map((nm) => parsePtBr(nm[0]));

    // Pair files with numbers
    for (let i = 0; i < files.length && i < numbers.length; i++) {
      rows.push({ file: files[i], claimedLines: numbers[i] });
    }
  }
  return rows;
}

function checkSecao3(metodo: string) {
  const rows = parseSecao3(metodo);
  if (rows.length === 0) {
    errors.push('§3: tabela de singletons não encontrada no METODO.md');
    return;
  }

  for (const row of rows) {
    const actual = fileLines(row.file);
    console.log(
      `§3 ${row.file}: doc=${row.claimedLines} real=${actual >= 0 ? actual : 'NOT FOUND'}`,
    );
    if (actual < 0) {
      errors.push(`§3 ${row.file}: arquivo não encontrado no repositório`);
    } else if (!withinTolerance(row.claimedLines, actual)) {
      mismatch(`§3 ${row.file}`, String(row.claimedLines), actual);
    }
  }

  // Warn if we couldn't parse any rows but the section exists
  if (rows.length === 0 && metodo.includes('# §3 ')) {
    warnings.push('§3: seção encontrada mas nenhuma linha da tabela foi parseada');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!existsSync(METODO_PATH)) {
    console.error(`METODO.md não encontrado em ${METODO_PATH}`);
    process.exit(2);
  }

  const metodo = readFileSync(METODO_PATH, 'utf8');

  checkHeader(metodo);
  console.log(''); // blank line
  checkSecao1(metodo);
  console.log('');
  checkSecao3(metodo);

  // Print warnings
  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) {
      console.log(`WARN: ${w}`);
    }
  }

  // Print errors and exit
  if (errors.length > 0) {
    console.log('');
    console.log(`=== ${errors.length} divergência(s) encontrada(s) ===`);
    for (const e of errors) {
      console.log(`ERR: ${e}`);
    }
    console.log('');
    console.log(
      'METODO.md está desatualizado. Atualize os números do §1 e §3 com os valores reais acima.',
    );
    process.exit(1);
  }

  console.log('');
  console.log('OK: METODO.md §1 e §3 conferem com o repositório.');
  process.exit(0);
}

// Só roda quando invocado como script — o teste importa as funções puras
// (mesmo padrão de scripts/check-dockerfile.ts).
if (process.argv[1] && resolve(process.argv[1]).endsWith('check-metodo.ts')) {
  main();
}
