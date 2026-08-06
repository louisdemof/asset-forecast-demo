# Front-end wiring — ligar o React ao Supabase

Como conectar o app (React 19 + Zustand) ao schema de `migrations/0001_init.sql`, **sem** quebrar
o que já funciona. `@supabase/supabase-js` **já está** no `package.json`.

Princípio: **o forecast continua vindo dos CSVs** (rápido, versionado, offline). O Supabase entra
**só** para os 4 dados mutáveis + login/permissões. Hoje esses dados vivem em memória no
`forecastStore` (`importaMedicoes`, `importaPVsyst`, `editaRegraCliente`, `CADASTRO_UC` hardcoded) e
**somem no refresh** — o objetivo é persistir.

---

## Fase 0 · Cliente + ambiente

**`src/lib/supabase.ts`** (novo):
```ts
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
export const supabaseOn = Boolean(import.meta.env.VITE_SUPABASE_URL);
```
`.env.local` (gitignored) + Vercel env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (anon é público por design — a RLS é a proteção; a `service_role` NUNCA vai pro front).

> `supabaseOn` = feature flag. Sem env → app roda 100% como hoje (memória). Liga gradual.

---

## Fase 1 · Auth + perfil/permissões

O **Gate de criptografia atual continua** (protege os dados públicos). Por cima dele, login de usuário:

**`src/store/authStore.ts`** (novo, Zustand):
```ts
interface AuthState {
  user: User | null;
  profile: Profile | null;                 // nome, department, role, manager
  perms: Record<string,                      // 'cadastro_uc' | 'faturas' | ...
           { read:boolean; write:boolean; validate:boolean; admin:boolean }>;
  signIn(email, pw): Promise<void>;
  signOut(): Promise<void>;
  can(recurso: string, acao: 'read'|'write'|'validate'|'admin'): boolean;  // espelha has_perm() do SQL
}
```
No login: `supabase.auth` → busca `profiles` + `role_permissions` (uma query com join) → guarda em `perms`.
`can()` no front **espelha** `has_perm()` no banco: front esconde/desabilita botões; **RLS é quem garante**.
Registra `user_activity` (`evento:'login'`) no sucesso.

---

## Fase 2 · Camada de acesso a dados

**`src/data/db/`** (novo) — um módulo tipado por tabela, CRUD fino:
```
src/data/db/
  cadastroUc.ts     listCadastro()  upsertUc(row)  deleteUc(id)
  faturas.ts        listFaturas()   upsertFatura(row)  confirmarFatura(id)
  metodos.ts        listMetodos()   upsertMetodo(cliente, patch)     // aba Métodos (por cliente)
  descontos.ts      listDescontos() upsertDesconto(usina, patch)     // desconto/PPA por usina
  validacoes.ts     listValidacoes()  validarMes(mes, metricas, obs)
  audit.ts          historicoDe(table, recordId)   // p/ o painel de histórico
```
Cada função é um `supabase.from('...').select/upsert/delete`. Erro → toast; sucesso → atualiza store.
Sem `supabaseOn`, caem no comportamento atual (memória) — o app nunca fica sem dado.

---

## Fase 3 · Ligar aos pontos de mutação que já existem

Trocar os 4 pontos in-memory do `forecastStore` por escrita + leitura no Supabase:

| Hoje (memória/código/CSV, some no refresh ou exige redeploy) | Vira |
|---|---|
| `CADASTRO_UC` (const hardcoded em `cadastroUC.ts`) | `listCadastro()` no boot → mesma `Record<uc,usina>`; editor grava `upsertUc` |
| `importaMedicoes()` (aplica injeção da fatura) | além de aplicar no cálculo, `upsertFatura()` persiste a fatura parseada |
| **`REGRAS_CLIENTE` (hardcoded em `clientes.ts`)** | **`listMetodos()` no boot → alimenta o motor; aba Métodos grava `upsertMetodo()`** |
| **Desconto por usina (`Contratos.csv`, read-only)** | **`listDescontos()` sobrepõe o desconto do CSV; aba Métodos grava `upsertDesconto()`** |
| `editaRegraCliente()` / `editaContrato()` (memória) | passam a persistir via `upsertMetodo` / override por usina |
| (não existe) validação do mês | `validarMes()` grava em `validacoes_mensais` |

**Boot** (`forecastStore.load()` no fim): se `supabaseOn`, carregar `metodos_cliente`, `descontos_usina`,
cadastro e faturas confirmadas, e **mesclar** por cima do baseline. Ordem de precedência:
**Supabase (editável) → código/CSV (seed/fallback)**. Sem `supabaseOn`, cai no `REGRAS_CLIENTE`/CSV atuais.

**Seed (uma vez):** exportar `REGRAS_CLIENTE` → `metodos_cliente` (16 linhas) e os descontos do
`Contratos.csv` → `descontos_usina` (98 linhas), além de `CADASTRO_UC` → `cadastro_uc`. Assim o banco
já nasce igual ao que o app calcula hoje — nada muda no número até alguém editar de propósito.

---

## Fase 4 · Componentes → tabelas

| Componente | Lê | Escreve | Gate de permissão |
|---|---|---|---|
| `GeracaoPanel` (drop de fatura) | `faturas` | `upsertFatura`, `confirmarFatura` | `can('faturas','write')` p/ o botão dividir/confirmar |
| **Cadastro editor** (novo) | `cadastro_uc` | `upsertUc/deleteUc` | `can('cadastro_uc','write' / 'admin')` |
| `MetodosPanel` (fica **editável**) | `metodos_cliente`, `descontos_usina` | `upsertMetodo`, `upsertDesconto` | `can('regras','write')` |
| `ContratoPanel` (override por usina) | `descontos_usina` | `upsertDesconto` | `can('regras','write')` |
| **ValidarMes** (novo, topo do dashboard) | `validacoes` | `validarMes` | `can('validacoes','validate')` |
| **Histórico** (novo, drawer) | `audit_log` via `historicoDe()` | — | `can('users','read')` |
| **Admin usuários** (novo) | `profiles/roles/departments` | ativar/atribuir role | `can('users','admin')` |

**Gating de UI**: um wrapper `<Can recurso="faturas" acao="write">…</Can>` que esconde/desabilita.
Não é segurança (a RLS é) — é UX: não mostrar botão que o banco vai recusar.

---

## Fase 5 · Botão "Validar forecast do mês"
- Um só clique no topo: snapshot das métricas do mês (receita, energia, desvio) → `metricas jsonb`,
  `status='validado'`, `validated_by/at` automáticos.
- Mostra "✓ validado por Fulano em dd/mm" ou "pendente"; `asset_manager`+ podem assinar.
- O `audit_log` já registra quem validou/reverteu — histórico grátis.

---

## Ordem sugerida de implementação
1. **Fase 0+1** — cliente + login + `can()` (nada muda no cálculo; só habilita o resto).
2. **Seed** `cadastro_uc` a partir do `CADASTRO_UC` atual.
3. **Fase 3** cadastro + faturas (persistir o que hoje some).
4. **Fase 5** botão validar (alto valor, baixo custo).
5. **Fase 4** editor de cadastro + admin de usuários + drawer de histórico.

Cada fase é atrás de `supabaseOn` — dá pra mergear sem risco enquanto o Supabase não está provisionado.
