/** Parser IN-BROWSER da fatura/demonstrativo da unidade GERADORA (GC fora da MeterHub).
 *  Reusa a lógica de extração do GD Analyzer (pdfjs + agrupamento por Y±4px + colunas
 *  separadas por " | "), o que evita o merge de coluna que tornava a injeção do
 *  DANF3E não confiável (o código da tarifa colava no valor). Extrai por documento:
 *  injeção · compensado · banco de créditos · custo da demanda · UC geradora.
 *
 *  Layouts: EMS_FATURA (Energisa MS DANF3E) · COSERN · EQUATORIAL_GO (Goiás) · COPEL (Paraná) · CPFL (Paulista) · ENEL_CE (Coelce) · ELEKTRO (Neoenergia SP). ESS (Energisa) usa o layout EMS. Suporta senha + OCR.
 */
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface FaturaGeradora {
  uc: string;        // identificador principal p/ exibir (matrícula EMS / código instalação COSERN)
  ucs: string[];     // TODOS os identificadores achados na fatura (matrícula + UC W-code) — p/ casar no cadastro
  mes: string; injecao: number; compensado: number; banco: number; demanda: number;
  doc: string; flag: string; arquivo: string;
}

const MESES: Record<string, number> = { janeiro: 1, fevereiro: 2, 'março': 3, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const MES_ABREV: Record<string, number> = { JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12 };

const num = (s: string): number => {
  const v = parseFloat((s || '').trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};
const ehNum = (s: string) => /^[\d.]*\d(?:,\d+)?$/.test(s.trim());
// ENEL CE usa PONTO como decimal (e ponto de milhar): "288.823.00" = 288823 · "345.23" = 345,23
const numDot = (s: string): number => { const v = parseFloat((s || '').replace(/\.(?=\d{3})/g, '')); return Number.isFinite(v) ? v : 0; };
// injeção é sempre inteiro de kWh → ignora TODO separador (robusto a OCR trocar "." por ","):
// "1.044.949" = "1.044,949" = "1044949" = 1044949
const numInt = (s: string): number => { const v = parseInt((s || '').replace(/[.,\s]/g, ''), 10); return Number.isFinite(v) ? v : 0; };

interface Item { x: number; y: number; text: string; }

/** Extrai linhas agrupando itens por Y±4px, colunas juntadas por " | " (GD Analyzer). */
async function extrairLinhas(file: File, password?: string): Promise<string[]> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), password }).promise;
  const linhas: { y: number; page: number; items: Item[] }[] = [];
  const Y_TOL = 4;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items as { str: string; transform: number[] }[]) {
      if (!it.str || !it.str.trim()) continue;
      const item: Item = { x: it.transform[4], y: it.transform[5], text: it.str.trim() };
      const ex = linhas.find((l) => l.page === p && Math.abs(l.y - item.y) <= Y_TOL);
      if (ex) { ex.items.push(item); ex.y = (ex.y + item.y) / 2; }
      else linhas.push({ y: item.y, page: p, items: [item] });
    }
  }
  linhas.sort((a, b) => a.page - b.page || b.y - a.y);
  return linhas.map((l) => l.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(' | '));
}

function mesDoNome(fn: string): string {
  const m = fn.match(/(20\d{2})[._-]?(0[1-9]|1[0-2])/);
  if (m) return `${m[1]}-${m[2]}`;
  for (const [nome, nn] of Object.entries(MESES)) {
    if (fn.toLowerCase().includes(nome)) { const y = fn.match(/20\d{2}/); if (y) return `${y[0]}-${String(nn).padStart(2, '0')}`; }
  }
  return '';
}

function detectar(t: string): string {
  // detecta pela DISTRIBUIDORA (COSERN e EMS ambos têm "Energia injetada")
  if (/EQUATORIAL GOI[ÁA]S|EQUATORIAL ENERGIA/i.test(t)) return 'EQUATORIAL_GO';
  if (/Elektro Redes|ELEKTRO/i.test(t)) return 'ELEKTRO';
  if (/EDP SP DISTRIB|EDP SP|edponline/i.test(t)) return 'EDP_SP'; // antes do EMS (EDP tb é DANF3E)
  if (/COPEL|Copel Distribui[çc][ãa]o/i.test(t)) return 'COPEL'; // antes do EMS (COPEL tb tem "ENERGIA INJETADA")
  if (/cpflempresas|Uso Sist Distr|Energia Atv Inj Ponta|Total Distribuidora/i.test(t)) return 'CPFL'; // marcadores de corpo (o logo "CPFL" não é texto no pdfjs)
  if (/Energia Injetada H(?:FP|P) no m|Companhia Energ[ée]tica do Cear[áa]|COELCE/i.test(t)) return 'ENEL_CE'; // pdfjs quebra "mês" em "m ê s"
  if (/RIO GRANDE DO NORTE|NEXUS ENERGIA RN|COSERN/i.test(t)) return t.includes('TOTAL INJETADO NO M') ? 'COSERN_DEMO' : 'COSERN_FATURA';
  if (t.includes('TOTAL INJETADO NO M')) return 'COSERN_DEMO';
  if (/MATO GROSSO|DANF3E|ENERGISA/i.test(t) || /Energia injetada/i.test(t)) return 'EMS_FATURA';
  return '';
}

// EQUATORIAL GOIÁS — geradora GC. Injeção e saldo vêm do bloco "INFORMAÇÕES DO SCEE":
//  GERAÇÃO CICLO (M/AAAA) KWH: UC <n> : P=.., FP=.., HR=..   → injeção = P+FP+HR
//  SALDO KWH: P=.., FP=.., HR=..                              → banco de créditos
//  DEMANDA GERAÇÃO kW <qtd> <tarifa> <valor R$>               → custo da demanda de geração
function parseEquatorialGo(plano: string, fn: string): FaturaGeradora {
  const flat = plano.replace(/\n+/g, ' '); // bloco SCEE pode quebrar em várias linhas Y
  const ger = flat.match(/GERA[ÇC][ÃA]O CICLO\s*\((\d{1,2})\/(20\d{2})\)[^:]*:\s*UC\s*(\d+)\s*:\s*P\s*=\s*([\d.]+,\d{2}),\s*FP\s*=\s*([\d.]+,\d{2}),\s*HR\s*=\s*([\d.]+,\d{2})/i);
  const injecao = ger ? num(ger[4]) + num(ger[5]) + num(ger[6]) : 0;
  const sal = flat.match(/SALDO KWH:\s*P\s*=\s*([\d.]+,\d{2}),\s*FP\s*=\s*([\d.]+,\d{2}),\s*HR\s*=\s*([\d.]+,\d{2})/i);
  const banco = sal ? num(sal[1]) + num(sal[2]) + num(sal[3]) : 0;
  const dm = flat.match(/DEMANDA GERA[ÇC][ÃA]O\s+kW\s+[\d.,]+\s+[\d.,]+\s+([\d.]+,\d{2})/i);
  const demanda = dm ? num(dm[1]) : 0;
  const mes = ger ? `${ger[2]}-${ger[1].padStart(2, '0')}` : mesDoNome(fn);
  const ucScee = ger ? ger[3].replace(/^0+/, '') : '';                                   // UC do SCEE (sem zeros à esquerda)
  const inst = ((flat.match(/\b\d\.\d{3}\.\d{3}\.\d{3}-\d{2}\b/) || [])[0] || '').replace(/\D/g, ''); // instalação do cabeçalho
  const ucs = [...new Set([ucScee, inst].filter(Boolean))];
  return { uc: ucs[0] || '', ucs, mes, injecao, compensado: 0, banco, demanda, doc: 'EQUATORIAL_GO', flag: '', arquivo: fn };
}

// COPEL (Paraná) — geradora GC. Do "Demonstrativo de saldos SCEE":
//  Saldo Mês Ponta X, Saldo Mês F Ponta Y      → injeção do mês = X+Y (crédito gerado)
//  Saldo Acumulado Ponta A, Saldo Acumulado F Ponta B → banco = A+B
//  DEMANDA USD ISENTA ICMS kW <qtd> <tarifa> <valor> → demanda de geração (isenta ICMS)
function parseCopel(plano: string, fn: string): FaturaGeradora {
  const flat = plano.replace(/\n+/g, ' ');
  const sm = flat.match(/Saldo M[êe]s Ponta\s+([\d.]+),?\s*Saldo M[êe]s F Ponta\s+([\d.]+)/i);
  const injecao = sm ? num(sm[1]) + num(sm[2]) : 0;
  const sa = flat.match(/Saldo Acumulado Ponta\s+([\d.]+),?\s*Saldo Acumulado F Ponta\s+([\d.]+)/i);
  const banco = sa ? num(sa[1]) + num(sa[2]) : 0;
  const dm = flat.match(/DEMANDA USD ISENTA ICMS\s+kW\s+[\d.,]+\s+[\d.,]+\s+([\d.]+,\d{2})/i);
  const demanda = dm ? num(dm[1]) : 0;
  const mm = flat.match(/ENERGIA INJETADA[^\n]{0,40}?(\d{2})\/(20\d{2})/i);
  const mes = mm ? `${mm[2]}-${mm[1]}` : mesDoNome(fn);
  const uc = (flat.match(/\b(\d{8,10})\s+(?:CONSUMO|GERAC)\b/i) || [])[1] || '';
  const ucs = [...new Set([uc, uc.replace(/^0+/, '')].filter(Boolean))];
  return { uc, ucs, mes, injecao, compensado: 0, banco, demanda, doc: 'COPEL', flag: '', arquivo: fn };
}

// CPFL Paulista — geradora GC. Injeção = resumo "kWh Injetado Ponta/FPonta";
//  demanda = "Uso Sist Distr Geração [kW]"; UC = "Instalação"; banco = "Saldo em Energia da Instalação".
function parseCpfl(plano: string, fn: string): FaturaGeradora {
  const flat = plano.replace(/\n+/g, ' ');
  // "Injetado Ponta N" / "Injetado FPonta N" — tolera variação do OCR (Injetada/Injetado) e
  // número com/sem separador. O dígito logo após "Ponta" separa do item de fatura ("… Ponta TE …").
  const ip = flat.match(/Inj[ei]tad[oa]\s+Ponta\s+([\d.,]+)/i);
  const ifp = flat.match(/Inj[ei]tad[oa]\s+FPonta\s+([\d.,]+)/i);
  const injecao = (ip ? numInt(ip[1]) : 0) + (ifp ? numInt(ifp[1]) : 0); // inteiro (ignora separador)
  // banco: frase contígua "…Instalação: Ponta X kWh Fora Ponta Y"
  const sal = flat.match(/Saldo em Energia da Instala[^:]{0,8}:\s*Ponta\s+([\d.]+,\d+)\s*kWh\s+Fora Ponta\s+([\d.]+,\d+)/i);
  const banco = sal ? num(sal[1]) + num(sal[2]) : 0;
  // demanda: "Uso Sist Distr Geração [kW] … kW <qtd> <tarifa1> <tarifa2> <VALOR>" → pula 3, pega o 4º
  const dm = flat.match(/Uso Sist Distr Gera[^[]{0,10}\[kW\][^\n]*?kW\s+[\d.,]+\s+[\d.,]+\s+[\d.,]+\s+([\d.]+,\d{2})/i);
  const demanda = dm ? num(dm[1]) : 0;
  const uc = (flat.match(/Instala[^\d]{0,12}(\d{8,12})/i) || [])[1] || ''; // → Araucária 07 no cadastro
  let mes = mesDoNome(fn);
  if (!mes) {
    const mm = flat.match(/\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\/(\d{2})\b/i);
    if (mm) mes = `20${mm[2]}-${String(MES_ABREV[mm[1].toUpperCase()]).padStart(2, '0')}`;
  }
  return { uc, ucs: [uc].filter(Boolean), mes, injecao, compensado: 0, banco, demanda, doc: 'CPFL', flag: '', arquivo: fn };
}

// ENEL CE (Companhia Energética do Ceará / Coelce) — geradora GC.
//  injeção: linhas do medidor "Energia Injetada-kWh FORA PONTA/PONTA ... <última coluna>" (vírgula-decimal)
//  banco:   texto "Saldo atualizado: X kWh" (ponto-decimal → numDot), somando os postos
//  demanda: "Demanda de Geração Ativa kW <qtd> <tarifa> <valor>"
//  mês: "mUC MM/AAAA" das parcelas de injeção; roteamento por nome do arquivo (Sertão NN)
function parseEnelCe(plano: string, fn: string): FaturaGeradora {
  const flat = plano.replace(/\n+/g, ' ');
  // injeção e saldo estão no bloco de texto (parágrafo), que o pdfjs lê de forma estável
  // (a tabela do medidor é reordenada pelo Y-agrupamento). Formato ponto-decimal → numDot.
  // pdfjs insere espaços em torno de acentos ("no mês" → "no m ê s") → tolera até o ":"
  const injFP = flat.match(/Energia Injetada HFP no m[^:]{0,8}:\s*([\d.]+)/i);
  const injP = flat.match(/Energia Injetada HP no m[^:]{0,8}:\s*([\d.]+)/i);
  const injecao = (injFP ? numDot(injFP[1]) : 0) + (injP ? numDot(injP[1]) : 0);
  const banco = [...flat.matchAll(/Saldo atualizado:\s*([\d.]+)/gi)].reduce((s, m) => s + numDot(m[1]), 0);
  const dm = flat.match(/DEMANDA DE GERA[ÇC][ÃA]O\s*-?\s*KW\s+([\d.]+,\d{2})/i) // resumo (qtd kW)
    || flat.match(/Demanda de Gera[çc][ãa]o Ativa[\s\S]{0,60}?([\d.]+,\d{2})/i); // item de fatura (R$)
  const demanda = dm ? num(dm[1]) : 0;
  const mm = flat.match(/mUC\s+(\d{2})\/(20\d{2})/i);
  const mes = mm ? `${mm[2]}-${mm[1]}` : mesDoNome(fn);
  const uc = (flat.match(/\b(\d{6,})-[A-Z]{2,4}-\d+/) || [])[1] || ''; // medidor (referência; roteia por nome do arquivo)
  return { uc, ucs: [uc].filter(Boolean), mes, injecao, compensado: 0, banco, demanda, doc: 'ENEL_CE', flag: '', arquivo: fn };
}

// ELEKTRO (Neoenergia SP) — geradora GC. Injeção = linha do medidor "ENERGIA INJETADA kWh"
//  (última coluna = kWh do mês); banco = "Saldo Acumulado Ponta/F Ponta" (0 quando rateia tudo);
//  demanda = "DEMANDA INJETADA … TUSD".
function parseElektro(plano: string, fn: string): FaturaGeradora {
  const flat = plano.replace(/\n+/g, ' ');
  const inj = flat.match(/ENERGIA INJETADA kWh\s+[\d.]+\s+[\d.]+\s+[\d.,]+\s+([\d.]+,\d{2})/i);
  let injecao = inj ? num(inj[1]) : 0;
  if (!injecao) { // fallback: soma PT + FP
    const pt = flat.match(/ENERGIA INJETADA PT kWh\s+[\d.]+\s+[\d.]+\s+[\d.,]+\s+([\d.]+,\d{2})/i);
    const fp = flat.match(/ENERGIA INJETADA FP kWh\s+[\d.]+\s+[\d.]+\s+[\d.,]+\s+([\d.]+,\d{2})/i);
    injecao = (pt ? num(pt[1]) : 0) + (fp ? num(fp[1]) : 0);
  }
  const sa = flat.match(/Saldo Acumulado Ponta\s+([\d.]+)[,\s]+Saldo Acumulado F Ponta\s+([\d.]+)/i);
  const banco = sa ? num(sa[1]) + num(sa[2]) : 0;
  const dm = flat.match(/DEMANDA INJETADA[^\n]*?TUSD\s+kW\s+[\d.,]*\s*[\d.,]+\s+[\d.,]+\s+([\d.]+,\d{2})/i);
  const demanda = dm ? num(dm[1]) : 0;
  const uc = (flat.match(/\b(\d{8})\b/) || [])[1] || ''; // UC (8 dígitos, no topo da fatura)
  return { uc, ucs: [uc].filter(Boolean), mes: mesDoNome(fn), injecao, compensado: 0, banco, demanda, doc: 'ELEKTRO', flag: '', arquivo: fn };
}

// EDP SP — geradora GC. Seção "INFORMAÇÕES SOBRE MICRO E MINIGERAÇÃO DISTRIBUÍDA":
//  Energia Injetada Ponta/Fora Ponta Cap./Fora Ponta Ind. no mês → injeção = soma
//  Saldo Total → banco. Demanda de geração não vem como R$ limpo (fica p/ edição manual).
function parseEdpSp(plano: string, fn: string): FaturaGeradora {
  const flat = plano.replace(/\n+/g, ' ');
  const v = (re: RegExp) => { const m = flat.match(re); return m ? num(m[1]) : 0; };
  const injecao = v(/Energia Injetada Ponta no m[êe]s\s*([\d.,]+)/i)
    + v(/Energia Injetada Fora Ponta Cap\.?\s*no m[êe]s\s*([\d.,]+)/i)
    + v(/Energia Injetada Fora Ponta Ind\.?\s*no m[êe]s\s*([\d.,]+)/i);
  const banco = v(/Saldo Total\s*([\d.,]+)/i);
  const uc = (flat.match(/MEDIDOR:\s*(\d+)/i) || [])[1] || '';
  return { uc, ucs: [uc].filter(Boolean), mes: mesDoNome(fn), injecao, compensado: 0, banco, demanda: 0, doc: 'EDP_SP', flag: '', arquivo: fn };
}

function parseEmsFatura(linhas: string[], plano: string, fn: string): FaturaGeradora {
  let mes = '';
  const mm = plano.match(/MATR[IÍ]CULA:\s*\d+-(\d{4})-(\d{2})/);
  if (mm) mes = `${mm[1]}-${mm[2]}`; else mes = mesDoNome(fn);
  if (!mes) {
    const pm = plano.match(/(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*\/\s*(20\d{2})/i);
    if (pm) mes = `${pm[2]}-${String(MESES[pm[1].toLowerCase().replace('ç', 'c')]).padStart(2, '0')}`;
  }
  // injeção = ÚLTIMA coluna numérica da linha "Energia injetada <posto>" (colunas separadas por |)
  let injecao = 0;
  for (const line of linhas) {
    if (/Energia injetada/i.test(line) && /(Fora Ponta|Ponta)/i.test(line)) {
      const nums = line.split('|').map((c) => c.trim()).filter(ehNum);
      if (nums.length) injecao += num(nums[nums.length - 1]);
    }
  }
  let banco = 0;
  const sm = plano.match(/Saldo Ac:\s*([\d.,]+)\s*\(P\)\s*([\d.,]+)\s*\(FP\)/i);
  if (sm) banco = num(sm[1]) + num(sm[2]);
  let demanda = 0;
  const dm = plano.match(/Demanda de Gera[çc][ãa]o TUSDG\s+KW\s+[\d.,]+\s+[\d.,]+\s+([\d.,]+)/i);
  if (dm) demanda = num(dm[1]);
  const uc = (plano.match(/MATR[IÍ]CULA:\s*(\d+)/) || [])[1] || '';
  const wcodes = [...new Set([...plano.matchAll(/\bW\d{6,}\b/gi)].map((m) => m[0]))]; // UC nas linhas de energia
  return { uc, ucs: [uc, ...wcodes].filter(Boolean), mes, injecao, compensado: 0, banco, demanda, doc: 'EMS_FATURA', flag: '', arquivo: fn };
}

// código da instalação COSERN — o valor vem ANTES de "NOTA FISCAL" (longe do rótulo)
function codigoCosern(plano: string): string {
  const m = plano.match(/(\d{6,8})\s+NOTA FISCAL/i)
    || plano.match(/C[ÓO]DIGO DA INSTALA[ÇC][ÃA]O[\s\S]{0,160}?\b(\d{6,8})\b/i);
  return m ? m[1] : '';
}

// COSERN DEMONSTRATIVO — totais limpos
function parseCosernDemo(plano: string, fn: string): FaturaGeradora {
  const val = (re: RegExp) => { const m = plano.match(re); return m ? num(m[1]) : 0; };
  const injecao = val(/TOTAL INJETADO NO M[ÊE]S \(kWh\)[^\d-]*([\d.]+,\d{2})/i);
  const compensado = val(/TOTAL COMPENSADO NO M[ÊE]S \(kWh\)[^\d-]*([\d.]+,\d{2})/i);
  const banco = val(/SALDO DISPON[IÍ]VEL PR[ÓO]X\.?\s*CICLO\s*\(kWh\)[^\d-]*([\d.]+,\d{2})/i);
  const uc = codigoCosern(plano);
  return { uc, ucs: [uc].filter(Boolean), mes: mesDoNome(fn), injecao, compensado, banco, demanda: 0, doc: 'COSERN_DEMO', flag: '', arquivo: fn };
}

// COSERN FATURA — layout varia por mês:
//  · injeção: "Energia injetada no mês = X" (recente) OU "Consumo Ativo Injetado Registrado" (antigo, última coluna)
//  · banco:   "Saldo atualizado de créditos" / "Saldo anterior total"
function parseCosernFatura(plano: string, fn: string): FaturaGeradora {
  const val = (re: RegExp) => { const m = plano.match(re); return m ? num(m[1]) : 0; };
  let injecao = val(/Energia injetada no m[êe]s\s*=?\s*([\d.]+,\d+)/i);
  if (!injecao) { // fallback layout antigo: soma a última coluna das linhas de injeção registrada
    for (const line of plano.split('\n')) {
      if (/Consumo Ativo Injetado Registrado/i.test(line)) {
        const nums = line.match(/[\d.]+,\d+/g);
        if (nums) injecao += num(nums[nums.length - 1]);
      }
    }
  }
  const banco = val(/Saldo (?:atualizado de cr[ée]ditos|anterior(?:\s+total)?|atual|total)[^\d=]*=?\s*([\d.]+,\d+)/i);
  const demanda = val(/Demanda de Inje[çc][ãa]o\s+kW\s+[\d.,]+\s+[\d.,]+\s+([\d.]+,\d{2})/i);
  const uc = codigoCosern(plano);
  return { uc, ucs: [uc].filter(Boolean), mes: mesDoNome(fn), injecao, compensado: 0, banco, demanda, doc: 'COSERN_FATURA', flag: '', arquivo: fn };
}

const semEspaco = (s: string) => s.replace(/\s+/g, '').length;

/** OCR (tesseract.js, grátis, roda no browser) — só p/ PDF imagem (sem camada de texto).
 *  Renderiza cada página num canvas e reconhece o texto em português. Carregado sob demanda. */
async function ocrPlano(file: File, password?: string): Promise<string> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), password }).promise;
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('por');
  let texto = '';
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 6 }); // ~432 DPI — abaixo disso o OCR erra dígito (216 DPI trocava separador)
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport }).promise;
      // binariza (cinza + threshold): remove fundos sombreados (ex.: caixa "Aviso importante"
      // do CPFL, onde fica o Saldo/banco) que o OCR descartava. Padrão de OCR e ajuda todo layout.
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = g > 153 ? 255 : 0; // ~60%
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);
      const ret = await worker.recognize(canvas);
      texto += ret.data.text + '\n';
    }
  } finally {
    await worker.terminate();
  }
  return texto;
}

const vazio = (fn: string, flag: string): FaturaGeradora => ({ uc: '', ucs: [], mes: '', injecao: 0, compensado: 0, banco: 0, demanda: 0, doc: '?', flag, arquivo: fn });

export async function parseFaturaGeradora(file: File, password?: string): Promise<FaturaGeradora> {
  let r: FaturaGeradora;
  let viaOcr = false;
  try {
    let linhas = await extrairLinhas(file, password);
    let plano = linhas.join('\n').replace(/ \| /g, ' '); // p/ matches por rótulo
    // PDF imagem (escaneado, sem camada de texto) → cai no OCR grátis
    if (semEspaco(plano) < 80) {
      const ocr = await ocrPlano(file, password);
      if (semEspaco(ocr) > 40) { plano = ocr; linhas = ocr.split('\n'); viaOcr = true; }
    }
    const tipo = detectar(plano);
    if (tipo === 'EQUATORIAL_GO') r = parseEquatorialGo(plano, file.name);
    else if (tipo === 'ELEKTRO') r = parseElektro(plano, file.name);
    else if (tipo === 'EDP_SP') r = parseEdpSp(plano, file.name);
    else if (tipo === 'COPEL') r = parseCopel(plano, file.name);
    else if (tipo === 'CPFL') r = parseCpfl(plano, file.name);
    else if (tipo === 'ENEL_CE') r = parseEnelCe(plano, file.name);
    else if (tipo === 'COSERN_DEMO') r = parseCosernDemo(plano, file.name);
    else if (tipo === 'COSERN_FATURA') r = parseCosernFatura(plano, file.name);
    else if (tipo === 'EMS_FATURA') r = parseEmsFatura(linhas, plano, file.name);
    else return vazio(file.name, viaOcr ? 'OCR: layout não reconhecido' : 'layout não reconhecido');
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err?.name === 'PasswordException' || /password/i.test(String(err?.message ?? e))) {
      return vazio(file.name, 'senha'); // PDF protegido → GeracaoPanel pede a senha e reprocessa
    }
    return vazio(file.name, 'erro ao ler PDF: ' + (err?.message ?? String(e)));
  }
  if (!r.mes) r.flag = 'sem mês — conferir';
  else if (r.injecao <= 0) r.flag = 'injeção 0 — usar demonstrativo';
  else if (r.injecao > 50_000_000) r.flag = 'injeção implausível — conferir';
  else if (r.banco > r.injecao * 400) r.flag = 'injeção baixa vs banco — conferir';
  if (viaOcr) r.flag = (r.flag ? r.flag + ' · ' : '') + '⚠ OCR — conferir'; // OCR pode errar dígito
  return r;
}
