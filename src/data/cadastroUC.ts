/** Cadastro UC geradora → usina (para rotear a fatura solta na aba Geração).
 *  A UC da fatura é a chave definitiva — resolve a ambiguidade (ex.: 5 Litorals).
 *  Onde a UC não estiver aqui, o roteamento cai para distribuidora + nome do arquivo.
 *
 *  Pré-preenchido com as matrículas EMS extraídas das faturas reais. As UCs COSERN
 *  (Litoral) entram assim que confirmarmos o "código da instalação" de cada uma.
 *  Editável pelo Asset (futuro: cadastro na plataforma).
 */
export const CADASTRO_UC: Record<string, string> = {
  // Equatorial Goiás — Jatobá 75 (a UC do SCEE mudou por troca de titularidade: 2 códigos)
  '91278073': 'Jatobá 75', '91278210': 'Jatobá 75',
  // COPEL — Planalto II
  '91278347': 'Planalto II', '91278484': 'Planalto II',
  // CPFL Paulista — Araucária 07
  '91278621': 'Araucária 07',
  // Energisa Sul-Sudeste (ESS, layout DANF3E → parser EMS) — Guará III
  '91278758': 'Guará III',
  // EDP SP — Serra Azul 12 (medidor)
  '91278895': 'Serra Azul 12',
  // Energisa MS (EMS) — matrícula E UC (W-code) apontam para a mesma usina
  '91279032': 'Ventania I', '91279169': 'Ventania I',
  '91279306': 'Ventania II', '91279443': 'Ventania II',
  '91279580': 'Ventania III', '91279717': 'Ventania III',
  '91279854': 'Ventania IV', '91279991': 'Ventania IV',
  '91280128': 'Quartzo', '91280265': 'Quartzo', // UC 1.366.461.051-80
  // COSERN (Litoral) — código de instalação
  '91280402': 'Litoral 12',
  '91280539': 'Litoral 10',
  // '<codigo>': 'Litoral 01', 'Litoral 02', 'Litoral 15' — a confirmar
  // ── MeterHub (AR/medidas) — geradora UC → usina, auto de comp_portfolio ──
  '90007672': 'Vale Verde I',
  '90022742': 'Vale Verde II',
  '90035072': 'Vale Verde III',
  '90049594': 'Vale Verde IV',
  '90064390': 'Vale Verde V',
  '90082063': 'Ipê 04',
  '90093845': 'Ipê 06',
  '90115217': 'Ipê 07-I',
  '90157139': 'Ipê 07-II',
  '90167140': 'Ipê 09',
  '90168373': 'Buriti - OPERON',
  '90184402': 'Sertão 01',
  '90257560': 'Sertão 02',
  '90333595': 'Guaíra I',
  '90347980': 'Guaíra II',
  '90361269': 'Guaíra III',
  '90374969': 'Guaíra IV',
  '90387847': 'Guaíra V',
  '90400040': 'Peroba 2 (TELCO)',
  '90433468': 'Peroba 3 (TELCO)',
  '90444976': 'Planalto I',
  '90452785': 'Planalto II',
  '90461279': 'Planalto III',
  '90471006': 'Planalto IV',
  '90484706': 'Planalto V',
  '90523203': 'Coqueiro 1',
  '90532519': 'Horizonte I',
  '90566495': 'Horizonte II',
  '90571016': 'Horizonte III',
  '90583483': 'Litoral 01',
  '90586771': 'Litoral 02',
  '90597731': 'Guará 1',
  '90612801': 'Guará 2',
  '90622802': 'Cerrado I',
  '90645955': 'Cerrado II',
  '90675684': 'Serra Azul 03',
  '90731306': 'Serra Azul 04',
  '90774598': 'Serra Azul 06',
  '90789120': 'Serra Azul 07',
  '90656504': 'Serra Azul 13',
  '90820630': 'Bandeirante',
  '90891733': 'Aroeira 1',
  '90912146': 'Aroeira 2',
  '90919681': 'Jacarandá 01',
};

/** Layout do documento → sigla da distribuidora (coluna Concessionária/disco). */
export const DOC_DISCO: Record<string, string> = {
  EMS_FATURA: 'EMS',
  EMS_DEMO: 'EMS',
  EQUATORIAL_GO: 'EQUATORIAL GO',
  ELEKTRO: 'Elektro SP',
  EDP_SP: 'EDP SP',
  COPEL: 'COPEL',
  CPFL: 'CPFL Pta',
  ENEL_CE: 'ENEL CE',
  COSERN: 'COSERN',
  COSERN_FATURA: 'COSERN',
  COSERN_DEMO: 'COSERN',
};
