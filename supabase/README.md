# Supabase — camada mutável do Asset Forecast

O **forecast em si continua read-only** (CSVs versionados no repo, gerados do *Forecast 6+6*).
O Supabase guarda só o que **pessoas criam/editam** e que precisa persistir entre sessões e usuários,
com **quem** fez e **quando** (histórico completo).

## O que entra aqui (e o que NÃO entra)

| Entra no Supabase (mutável) | Fica no CSV (read-only) |
|-----------------------------|-------------------------|
| Cadastro UC → usina | P50 / PVsyst |
| Faturas da geradora (GC fora da MeterHub) | Perdas / perfOper |
| **Método de cálculo por cliente** (gross-up, base, residual, fee) | Energia Final (calculada) |
| **Desconto / PPA por usina** (+ índice de reajuste) | Datas brutas de contrato |
| Validação mensal do forecast | Injeção/compensação da MeterHub (via API) |
| Usuários, papéis, permissões, histórico | — |

> Rateio e compensação da **MeterHub** continuam vindo da **API** (automático) — não se duplicam aqui.
> Só a **geração comparthilada fora da MeterHub** é alimentada manualmente (fatura → parser → `faturas_geradora`).

## Três blocos (arquivo `migrations/0001_init.sql`)

### 1. Usuários — RBAC estilo Salesforce
- **`departments`** — Asset, Comercial, Engenharia, O&M, Financeiro, Diretoria, TI
- **`roles`** — admin · asset_manager · asset_analyst · comercial · viewer (com `nivel` p/ hierarquia)
- **`role_permissions`** — matriz **role × recurso × ação** (`read / write / validate / admin`)
- **`profiles`** — 1:1 com `auth.users`; tem `department_id`, `role_id` e **`manager_id`** (quem reporta a quem)

Quem pode o quê (resumo):

| Role | cadastro/faturas/regras | validar mês | apagar | gerir usuários |
|------|:--:|:--:|:--:|:--:|
| admin | ✅ | ✅ | ✅ | ✅ |
| asset_manager | ✅ editar | ✅ | ✅ | 👁 lê |
| asset_analyst | ✅ editar | — | — | — |
| comercial | 👁 (só regras edita) | — | — | — |
| viewer | 👁 | — | — | — |

### 2. Dados de domínio
`cadastro_uc` · `faturas_geradora` · **`metodos_cliente`** · **`descontos_usina`** · `validacoes_mensais`
Cada uma carrega `created_by / updated_by / created_at / updated_at` automáticos.

- **`metodos_cliente`** — o MÉTODO por offtaker (gross-up, base, residual, PIS/ICMS, take-or-pay, fee).
  É a fonte da verdade que **substitui** o `REGRAS_CLIENTE` hardcoded em `clientes.ts` — seed vem do código,
  depois Asset/Comercial editam pela aba **Métodos** (que deixa de ser read-only).
- **`descontos_usina`** — o desconto (%) ou preço PPA (R$/MWh) por usina, hoje preso no `Contratos.csv`,
  mais o **índice de reajuste** do PPA (IPCA/IGP-M/custo de energia — Pergunta 5.3).

> A **aba Métodos** passa a **ler e gravar** nessas duas tabelas. O Excel `Metodos_Calculo_por_Cliente.xlsx`
> vira só um **export/snapshot** do banco, não uma fonte paralela.

### 3. Histórico
- **`audit_log`** — *toda* alteração (INSERT/UPDATE/DELETE) em qualquer tabela de domínio, com
  `changed_fields`, `old_data`, `new_data`, `actor`. Via trigger `fn_audit()` — nada escapa.
- **`user_activity`** — login / export / import / view por usuário.

## Segurança
- **RLS ligado em tudo.** Nenhuma linha sai sem `has_perm(recurso, ação)` passar.
- Novo signup entra como **viewer inativo** — um admin precisa liberar (`is_active`) e dar role.
- `fn_*` são `security definer` (rodam com privilégio para gravar audit/criar profile), o resto respeita RLS.

## Subir
```bash
supabase db push                                  # 1. aplica migrations/0001_init.sql
psql "$DATABASE_URL" -f supabase/seed/0001_seed.sql   # 2. enche métodos + descontos (16 clientes, 98 usinas)
# (regerar o seed a partir do motor+CSV:  python3 scripts/seed_supabase.py)
# depois, promova você mesmo a admin (ver rodapé do SQL):
#   update profiles set role_id=(select id from roles where nome='admin'),
#     department_id=(select id from departments where nome='TI'), is_active=true
#   where email='<seu-email>';
```

## Próximos passos (fora deste arquivo)
1. **Storage bucket** `faturas` (PDFs) — `faturas_geradora.arquivo` aponta pra lá.
2. Ligar o front: cliente Supabase + trocar os `localStorage`/estado por leituras/escritas nas 4 tabelas.
3. Botão **"Validar forecast do mês"** → grava em `validacoes_mensais` (status + snapshot de métricas).
4. Preencher **`descontos_usina.reajuste_indice`** nas 5 usinas PPA assim que o Comercial responder
   a pergunta **5.3** do `PERGUNTAS_ASSET.md` (IPCA? IGP-M? custo de energia?).
